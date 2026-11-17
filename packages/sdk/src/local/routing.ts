// Spawns bridges for environments on this machine: inline ones are stamped, named ones routed by
// overrides. As hai_agents_local/routing.py, web only: the one bridge type is PlaywrightBrowserBridge,
// so a desktop or workstation environment is refused like any kind this machine cannot serve.
// TS ahead of Python (`ts-ahead` in parity-exceptions.json): `bridgeOptions`, a product's per-environment
// options (a Playwright context, a driver factory, `onCommand`, a viewport) added to the bridge the walk
// builds; Python's `auto_bridges` is a bool and its bridges take no options.

import { createHash } from "node:crypto";

import type { HaiAgents } from "../client/index.js";
import { PlaywrightBrowserBridge, type PlaywrightBrowserBridgeOptions } from "./browser.js";
import { defaultBaseUrl } from "./config.js";

export type AgentLike = string | HaiAgents.Agent | Record<string, unknown>;
export type EnvironmentLike = string | HaiAgents.Environment | Record<string, unknown>;
// Python keys `resolved` by a ("agent" | "environment", name) tuple; a JS Map cannot, so the key is the pair joined by its first colon.
export type Reference = `agent:${string}` | `environment:${string}`;
export type Resolved = Partial<Record<Reference, unknown>>;

export type LocalBridgeType = typeof PlaywrightBrowserBridge;

/** What a product adds to an auto-started web bridge (ts-ahead); the transport, the session id and the environment id are the walk's. */
export type WebBridgeOptions = Omit<PlaywrightBrowserBridgeOptions, "apiKey" | "baseUrl" | "fetch" | "sessionId" | "environmentId">;
/** Per-kind factories of those options, given the environment spec the bridge will serve (ts-ahead). */
export type AutoBridgeOptions = { web?: (environment: EnvironmentLike) => WebBridgeOptions };
/** `autoBridges`: on, off, or on with a product's options (ts-ahead; Python's `auto_bridges` is a bool). */
export type AutoBridges = boolean | AutoBridgeOptions;

export const BRIDGE_TYPES: Record<string, LocalBridgeType> = {
  [PlaywrightBrowserBridge.environmentKind]: PlaywrightBrowserBridge,
};

export interface Localized {
  agent: AgentLike;
  bridges: PlaywrightBrowserBridge[];
  overrides: Record<string, string>;
}

export interface LocalizeOptions {
  apiKey: string;
  baseUrl?: string;
  // Python flags `verify_runtime` on each bridge after the walk; the TS proof check is the runtime's `fetch`, given to the bridge at construction.
  fetch?: typeof fetch;
  resolved?: Resolved;
  claimed?: Iterable<string>;
  seed?: string;
  /** A product's options for each bridge, by kind (ts-ahead, header). */
  bridgeOptions?: AutoBridgeOptions;
}

export function reference(kind: "agent" | "environment", name: string): Reference {
  return `${kind}:${name}`;
}

/** Names in the caller's agent tree whose specs decide whether a bridge is needed. */
export function references(agent: AgentLike): Reference[] {
  if (typeof agent === "string") {
    return [reference("agent", agent)];
  }
  const found: Reference[] = [];
  for (const env of _list(agent, "environments")) {
    if (typeof env === "string") {
      found.push(reference("environment", env));
    }
  }
  for (const sub of _list(agent, "subagents")) {
    found.push(...references(sub as AgentLike));
  }
  return found;
}

/** `name:N` pins a revision; any other colon is part of the name. */
export function splitRevision(reference: string): [string, number | undefined] {
  const at = reference.lastIndexOf(":");
  const revision = at === -1 ? "" : reference.slice(at + 1);
  return /^\d+$/.test(revision) ? [reference.slice(0, at), Number(revision)] : [reference, undefined];
}

/** The bridges this machine serves `agent`'s environments with, whether or not a session already binds them. */
export function localBridgeTypes(agent: AgentLike, resolved: Resolved = {}): LocalBridgeType[] {
  if (typeof agent === "string") {
    const spec = resolved[reference("agent", agent)];
    return spec == null ? [] : localBridgeTypes(spec as AgentLike, resolved);
  }
  const found: LocalBridgeType[] = [];
  for (const env of _list(agent, "environments")) {
    const spec = typeof env === "string" ? resolved[reference("environment", env)] : env;
    const kind = spec == null ? undefined : _localKind(spec as EnvironmentLike);
    if (kind !== undefined) {
      found.push(_bridgeType(kind));
    }
  }
  for (const sub of _list(agent, "subagents")) {
    found.push(...localBridgeTypes(sub as AgentLike, resolved));
  }
  return found;
}

/** Bridges for unclaimed user_device envs; a `seed` makes their session ids reproducible across retries. */
export function localizeAgent(agent: AgentLike, options: LocalizeOptions): Localized {
  const walk = new _Walk(options);
  return { agent: walk.agent(agent, "agent", false), bridges: walk.bridges, overrides: walk.overrides };
}

class _Walk {
  readonly bridges: PlaywrightBrowserBridge[] = [];
  readonly overrides: Record<string, string> = {};
  readonly #options: LocalizeOptions;
  readonly #resolved: Resolved;
  readonly #claimed: Set<string>;

  constructor(options: LocalizeOptions) {
    this.#options = options;
    this.#resolved = options.resolved ?? {};
    this.#claimed = new Set(options.claimed ?? []);
  }

  agent(agent: AgentLike, path: string, byName: boolean): AgentLike {
    if (typeof agent === "string") {
      const spec = this.#resolved[reference("agent", agent)];
      if (spec != null) {
        this.agent(spec as AgentLike, path, true);
      }
      return agent;
    }
    const changes: Record<string, unknown> = {};
    const environments = _read(agent, "environments");
    if (Array.isArray(environments)) {
      const localizedEnvs = environments.map((env) => this.environment(env as EnvironmentLike, path, environments, byName));
      if (_anyReplaced(localizedEnvs, environments)) {
        changes.environments = localizedEnvs;
      }
    }
    const subagents = _read(agent, "subagents");
    if (Array.isArray(subagents)) {
      const localizedSubs = subagents.map((sub) => this.agent(sub as AgentLike, _subagentPath(path, sub as AgentLike), byName));
      if (_anyReplaced(localizedSubs, subagents)) {
        changes.subagents = localizedSubs;
      }
    }
    return Object.keys(changes).length > 0 ? _replace(agent, changes) : agent;
  }

  environment(env: EnvironmentLike, path: string, siblings: unknown[], byName: boolean): EnvironmentLike {
    if (typeof env === "string") {
      const spec = this.#resolved[reference("environment", env)];
      if (spec != null) {
        this.environment(spec as EnvironmentLike, path, siblings.map((sibling) => this.lookup(sibling as EnvironmentLike)), true);
      }
      return env;
    }
    const kind = _localKind(env);
    // Python reads and stamps `session_id`; the generated TS environment objects carry camelCase fields (the serde layer), while the override key below stays the wire string.
    if (kind === undefined || _read(env, "sessionId")) {
      return env;
    }
    const key = `${path}.environments[kind=${kind}].session_id`;
    for (const claim of this.#claimed) {
      if (key === claim || key.startsWith(`${claim}.`)) {
        return env;
      }
    }
    const serve = SERVE_COMMANDS[_bridgeType(kind).environmentKind];
    if (!byName) {
      return _replace(env, { kind, sessionId: this.bridge(env, kind).sessionId });
    }
    if (siblings.filter((sibling) => _kind(sibling) === kind).length > 1) {
      throw new Error(
        `${path} has several ${kind} environments, so the platform cannot route its local ${kind} ` +
          `by kind; give it an explicit sessionId and serve it with \`${serve}\``,
      );
    }
    if (!key.split(".").every((segment) => _SEGMENT.test(segment))) {
      throw new Error(
        `cannot route the local ${kind} at ${path}: override paths split on dots, so a subagent ` +
          `name with '.', '[' or ']' cannot be addressed; rename it, or give the environment an explicit ` +
          `sessionId and serve it with \`${serve}\``,
      );
    }
    this.overrides[key] = this.bridge(env, kind).sessionId;
    return env;
  }

  lookup(env: EnvironmentLike): unknown {
    return typeof env === "string" ? (this.#resolved[reference("environment", env)] ?? env) : env;
  }

  bridge(env: EnvironmentLike, kind: string): PlaywrightBrowserBridge {
    const bridgeType = _bridgeType(kind);
    if (this.bridges.some((bridge) => bridge.constructor === bridgeType)) {
      throw new Error(
        `the agent tree has multiple local ${kind} environments that this machine would serve the same ` +
          "way, but it can only serve one; give the extra environments an explicit sessionId and serve " +
          `each from its own machine with \`${SERVE_COMMANDS[bridgeType.environmentKind]}\``,
      );
    }
    const seed = `${this.#options.seed}:${bridgeType.environmentKind}`;
    const sessionId = this.#options.seed === undefined ? undefined : uuid5(NAMESPACE_URL, seed);
    // The workstation options (screenshot width, mode) are not read: no workstation bridge in TS.
    // ts-ahead: the product's options first, so the walk's transport, environment id and session id win.
    const product = this.#options.bridgeOptions?.[bridgeType.environmentKind as keyof AutoBridgeOptions]?.(env) ?? {};
    const bridge = new bridgeType({
      ...product,
      environmentId: _read(env, "id") as string | undefined,
      apiKey: this.#options.apiKey,
      // Python's LocalBridge defaults base_url itself; the TS transport requires one, so the default lands here.
      baseUrl: this.#options.baseUrl ?? defaultBaseUrl(),
      fetch: this.#options.fetch,
      sessionId,
    });
    this.bridges.push(bridge);
    return bridge;
  }
}

// Python names the `holo local browser --session-id <id>` command; there is no CLI in TS, so the hand-built bridge is named.
export const SERVE_COMMANDS: Record<string, string> = {
  [PlaywrightBrowserBridge.environmentKind]: "new PlaywrightBrowserBridge({ sessionId })",
};
const _SEGMENT = /^[A-Za-z_]\w*(?:\[[^[\]]+\])?$/;
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function _subagentPath(path: string, sub: AgentLike): string {
  const name = typeof sub === "string" ? splitRevision(sub)[0] : _read(sub, "name");
  return `${path}.subagents[name=${name}]`;
}

function _kind(env: unknown): string | undefined {
  if (typeof env === "string") {
    return undefined;
  }
  // The generated TS environments are plain objects that always carry `kind`; Python also reads it off the model class.
  return (_read(env, "kind") as string | undefined) || "web";
}

/** The kind of `env` when this machine serves it: a browser on user_device. */
function _localKind(env: EnvironmentLike): string | undefined {
  const kind = _kind(env);
  // Python serves a desktop from this machine whatever its host; TS has no desktop bridge, so a desktop is refused below with the other unsupported kinds.
  if (kind !== "desktop" && _read(env, "host") !== "user_device") {
    return undefined;
  }
  if (kind === undefined || !Object.hasOwn(BRIDGE_TYPES, kind)) {
    throw new Error(
      `user_device environment ${repr(_read(env, "id"))} has kind ${repr(kind)}, which cannot be served by a ` +
        `local bridge; supported kinds: [${Object.keys(BRIDGE_TYPES).sort().map(repr).join(", ")}]`,
    );
  }
  return kind;
}

// Python picks the workstation bridge for a shell-mode desktop here; no desktop or workstation bridge in TS.
function _bridgeType(kind: string): LocalBridgeType {
  return BRIDGE_TYPES[kind]!;
}

function _anyReplaced(localized: unknown[], original: unknown[]): boolean {
  return localized.some((item, index) => item !== original[index]);
}

/** The public API accepts agents/environments as plain objects (the generated types are); read any key of one. */
function _read(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Python iterates `_read(obj, key) or []`; anything but an array counts as empty here. */
function _list(obj: unknown, key: string): unknown[] {
  const value = _read(obj, key);
  return Array.isArray(value) ? value : [];
}

/** Copy-with-changes; anything but a plain object cannot carry a session id. */
function _replace<T>(obj: T, changes: Record<string, unknown>): T {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    return { ...obj, ...changes };
  }
  throw new TypeError(
    `cannot set [${Object.keys(changes).sort().join(", ")}] on ${typeof obj}; ` +
      "pass user_device agents and environments as plain objects",
  );
}

/** Python's `!r` of a string or None, so the error texts read the same. */
function repr(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : value == null ? "None" : String(value);
}

/** Python's uuid.uuid5 (RFC 4122 name-based, SHA-1); Node's crypto has no version 5. */
function uuid5(namespace: string, name: string): string {
  const hash = createHash("sha1").update(Buffer.from(namespace.replace(/-/g, ""), "hex")).update(name, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

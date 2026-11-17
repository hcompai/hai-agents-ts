// Environment variables read by hai-agents/local, as hai_agents_local/config.py. Web only: the
// shell desktop variables (HAI_SHELL_POLICY, HAI_SHELL_SANDBOX, HAI_SHELL_WORKSPACE) and their
// helpers are not here, as there is no workstation bridge in TS.

import { HaiAgentsEnvironment } from "../client/index.js";

export const BASE_URL_ENV_VAR = "HAI_API_BASE_URL";
export const AUTO_BRIDGE_ENV_VAR = "HAI_AUTO_BRIDGE";

export const DEFAULT_BASE_URL: string = HaiAgentsEnvironment.Eu;

const FLAG_FALSE = new Set(["0", "false", "no"]);

export function defaultBaseUrl(): string {
  return process.env[BASE_URL_ENV_VAR]?.trim() || DEFAULT_BASE_URL;
}

/** Read at each session creation, so the flag can be flipped at runtime. */
export function autoBridgesEnabled(): boolean {
  return !FLAG_FALSE.has((process.env[AUTO_BRIDGE_ENV_VAR] ?? "").trim().toLowerCase());
}

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CommandBridge, HaiAgentsClient } from "../src/index.js";

interface Posted {
  id: string;
  result: unknown;
  error: string | null;
  command_uid: string;
}

/** A command channel with local-runtime semantics: pending commands are redelivered until answered. */
async function fakeChannel(polls: unknown[][]) {
  const state = { registered: false, polledBeforeRegistering: false, posted: [] as Posted[] };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
    });
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    if (req.method === "POST" && req.url === "/api/v1/trajectories/") {
      state.registered = true;
      res.writeHead(201).end(body);
    } else if (req.url?.startsWith("/api/v1/trajectories/")) {
      res.writeHead(state.registered ? 200 : 404).end("{}");
    } else if (req.url?.includes("/commands?")) {
      if (!state.registered) state.polledBeforeRegistering = true;
      const next = polls.shift();
      if (!next) res.writeHead(410).end();
      else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(next));
    } else if (req.method === "POST" && req.url?.endsWith("/result")) {
      state.posted.push({ id: req.url.split("/")[4]!, ...JSON.parse(body) });
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  servers.push(server);
  return { state, client: new HaiAgentsClient({ baseUrl, apiKey: "key" }) };
}

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

const command = (uid: string, name: string, args: Record<string, unknown> = {}) => ({ id: uid, command_uid: uid, name, args });

describe("CommandBridge", () => {
  it("registers before polling, runs each command once, and stops when the channel closes", async () => {
    const click = command("c1", "click_at", { x: 10, y: 20, button: "left" });
    const { state, client } = await fakeChannel([[click], [click]]);
    const clicks: unknown[] = [];

    const bridge = await CommandBridge.open(client, { click_at: (args) => void clicks.push(args) });
    await bridge.done;

    expect(state.polledBeforeRegistering).toBe(false);
    expect(clicks).toEqual([{ x: 10, y: 20, button: "left" }]);
    expect(state.posted).toEqual([
      { id: "c1", result: null, error: null, command_uid: "c1" },
      { id: "c1", result: null, error: null, command_uid: "c1" },
    ]);
  });

  it("answers unsupported commands and driver failures with an error string", async () => {
    const { state, client } = await fakeChannel([[command("c1", "observe"), command("c2", "goto", { url: "x" })]]);

    const bridge = await CommandBridge.open(client, {
      goto: () => {
        throw new Error("x is not reachable");
      },
    });
    await bridge.done;

    expect(state.posted.map(({ result, error }) => [result, error])).toEqual([
      [null, "command 'observe' is not supported by this bridge"],
      [null, "x is not reachable"],
    ]);
  });
});

/** test_runtime_placement.py's runtime stand-ins, shared by runtime_placement.test.ts and runtime_placement_bridges.test.ts. */
import { createHmac } from "node:crypto";
import * as http from "node:http";
import type * as net from "node:net";

/** A loopback stand-in for the runtime: answers every response with an HMAC proof keyed by `proofToken`. */
export class RuntimeServer {
  token: string;
  proofToken: string | null;
  requests: Set<string>[] = [];
  active: string[] = [];
  cancelled: string[] = [];
  private server: http.Server;

  constructor(token: string) {
    this.token = token;
    this.proofToken = token;
    this.server = http.createServer((request, response) => this.route(request, response));
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  listen(port = 0): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, "127.0.0.1", resolve));
  }

  /** serve_forever on a daemon thread. */
  static async start(token: string, port = 0): Promise<RuntimeServer> {
    const server = new RuntimeServer(token);
    await server.listen(port);
    return server;
  }

  /** shutdown() + server_close() */
  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private route(request: http.IncomingMessage, response: http.ServerResponse): void {
    this.requests.push(new Set(Object.keys(request.headers).map((name) => name.toLowerCase())));
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, body: unknown) => this.reply(request, response, status, body);
    if (url.pathname === "/health") return reply(200, { recipe: "shared", version: "test" });
    if (request.headers.authorization !== `Bearer ${this.token}`) return reply(401, { error: "unauthorized" });
    if (request.method === "GET" && url.pathname === "/api/v2/sessions") {
      const items = this.active.map((sid) => ({ id: sid, status: "running", created_at: "2026-01-01T00:00:00Z" }));
      return reply(200, { items, total: items.length, page: 1 });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/v2/sessions/")) {
      const sessionId = url.pathname.split("/").at(-1)!;
      this.cancelled.push(sessionId);
      if (!this.active.includes(sessionId)) return reply(404, { detail: "Session not found" });
      this.active.splice(this.active.indexOf(sessionId), 1);
      return reply(204, null);
    }
    reply(404, { detail: "Not Found" });
  }

  private reply(request: http.IncomingMessage, response: http.ServerResponse, status: number, body: unknown): void {
    const payload = body === null ? "" : JSON.stringify(body);
    const challenge = request.headers["x-hai-runtime-challenge"];
    if (typeof challenge === "string" && this.proofToken) {
      const proof = createHmac("sha256", this.proofToken).update(challenge).digest("hex");
      response.setHeader("X-Hai-Runtime-Proof", proof);
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Length", String(Buffer.byteLength(payload)));
    response.writeHead(status);
    response.end(payload);
  }
}

/** Python's FakeRuntime: a runtime the client holds and never starts. */
export class FakeRuntime {
  baseUrl = "http://127.0.0.1:18795";
  apiKey = "local-token";
  owned = true;
  stopped = false;
  fetch = globalThis.fetch;

  async requireRecipe(_recipe: string | undefined): Promise<void> {}

  shutdown(): void {
    this.stopped = true;
  }
}

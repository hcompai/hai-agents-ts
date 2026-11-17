// A stand-in for the hai-agent-runtime binary: the routes the launcher touches, with the same
// bearer check and identity proof the real one applies. Started like the real binary, from env.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const token = process.env.HAI_AGENT_RUNTIME_API_TOKEN;
const port = Number(process.env.HAI_AGENT_RUNTIME_PORT);
if (process.env.FAKE_RUNTIME_EXIT) {
  console.error("fake runtime refusing to start");
  process.exit(3);
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const challenge = req.headers["x-hai-runtime-challenge"];
  if (challenge && !process.env.FAKE_RUNTIME_NO_PROOF) {
    res.setHeader("X-Hai-Runtime-Proof", createHmac("sha256", token).update(challenge).digest("hex"));
  }
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    return json(res, 200, { status: "ok", version: "0.0.0-fake", recipe: process.env.HAI_AGENT_RUNTIME_RECIPE ?? "legacy" });
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    return json(res, 401, { error: "unauthorized" });
  }
  if (url.pathname === "/api/v2/sessions") {
    return json(res, 200, { items: [], total: 0, page: 1 });
  }
  if (url.pathname === "/fake/env") {
    return json(res, 200, process.env);
  }
  json(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1");

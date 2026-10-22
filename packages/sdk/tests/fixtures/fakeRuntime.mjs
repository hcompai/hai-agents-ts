#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const token = "fake-token";
const now = new Date().toISOString();
const sessions = [{ id: "finished", status: "completed", created_at: now }];
if (process.env.FAKE_FOREIGN_SESSION === "1") sessions.push({ id: "foreign", status: "running", created_at: now });

if (process.env.FAKE_FAIL) {
  process.stderr.write(`${process.env.FAKE_FAIL}\n`);
  process.exit(3);
}

const server = createServer((req, res) => {
  const challenge = req.headers["x-hai-runtime-challenge"];
  if (challenge && process.env.FAKE_UNPROVEN !== "1") {
    res.setHeader("X-Hai-Runtime-Proof", createHmac("sha256", token).update(challenge).digest("hex"));
  }
  res.setHeader("Content-Type", "application/json");
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url.startsWith("/api/v2/sessions")) {
      const session = { id: randomUUID(), status: "running", created_at: now };
      sessions.push(session);
      res.end(JSON.stringify({ ...session, request: JSON.parse(body), status: { status: "running" } }));
    } else if (req.url.startsWith("/api/v2/sessions")) {
      const wanted = new URL(req.url, "http://fake").searchParams.getAll("status");
      const items = wanted.length ? sessions.filter((session) => wanted.includes(session.status)) : sessions;
      res.end(JSON.stringify({ items, total: items.length, page: 1, size: 50 }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ url, token, pid: process.pid, version: "0.0.0-fake", owned: true, log: "" }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));

// Failure modes: stdout contains non-protocol text; unknown tools execute arbitrary endpoints; malformed arguments reach
// the hub; an HTTP failure becomes a successful tool result; notifications get responses; source keys act as owner keys;
// a client that asked to read only writes anyway; --allow-writes doesn't.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { after } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("mcp");
let calls: any[] = [];
const server = createServer((req, res) => {
  calls.push([req.url, req.headers.authorization]);
  res.statusCode = req.url?.includes("999") ? 404 : 200;
  res.end(JSON.stringify({ ok: true }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    owner: "owner-key",
    source: { name: "app", key: "source-key" },
  }),
);
function mcp(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  calls = [];
  const child = spawn(process.execPath, [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "mcp", ...args], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let err = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (err += b));
  return {
    child,
    done: once(child, "close").then(() => ({
      err,
      calls,
      responses: output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    })),
  };
}
const speak = (child: any, messages: object[]) =>
  child.stdin.end(messages.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
const hello = { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const list = { id: 2, method: "tools/list" };
test("read-only by default: only status and why, and the writing tools are unknown", async () => {
  const { child, done } = mcp();
  speak(child, [
    hello,
    { method: "notifications/initialized" },
    list,
    { id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "why", arguments: { run: -1 } } },
    { id: 5, method: "tools/call", params: { name: "why", arguments: { run: 999 } } },
    { id: 6, method: "tools/call", params: { name: "request", arguments: { path: "/etc/passwd" } } },
    { id: 7, method: "tools/call", params: { name: "answer", arguments: { card: 1, choice: 0 } } },
    { id: 8, method: "tools/call", params: { name: "emit", arguments: { id: "a", type: "one" } } },
  ]);
  const { responses, err, calls: made } = await done;
  assert.equal(err, "");
  assert.equal(responses.length, 8, "每一条要回的都回了，通知没有回");
  const get = (id: number) => responses.find((r: any) => r.id === id);
  assert.equal(get(1).result.protocolVersion, "2025-11-25");
  assert.deepEqual(get(2).result.tools.map((t: any) => t.name), ["status", "why"]);
  assert.equal(get(3).result.isError, undefined);
  assert.equal(get(4).error.code, -32602);
  assert.equal(get(5).result.isError, true);
  assert.equal(get(6).error.code, -32602);
  assert.equal(get(7).error.code, -32602, "answering is not available without --allow-writes");
  assert.equal(get(8).error.code, -32602);
  assert.deepEqual(made, [
    ["/v1/state", "Bearer owner-key"],
    ["/v1/runs/999/why", "Bearer owner-key"],
  ]);
});
test("--allow-writes exposes the writing tools, each with the key it belongs to", async () => {
  const { child, done } = mcp(["--allow-writes"]);
  speak(child, [
    hello,
    { method: "notifications/initialized" },
    list,
    { id: 3, method: "tools/call", params: { name: "answer", arguments: { card: 1, choice: 0 } } },
    { id: 4, method: "tools/call", params: { name: "emit", arguments: { id: "a", type: "one" } } },
  ]);
  const { responses, calls: made } = await done;
  const get = (id: number) => responses.find((r: any) => r.id === id);
  assert.deepEqual(get(2).result.tools.map((t: any) => t.name), [
    "status",
    "why",
    "answer",
    "resolve",
    "stop",
    "emit",
    "tell",
  ]);
  assert.equal(get(3).result.isError, undefined);
  assert.equal(get(4).result.isError, undefined);
  assert.deepEqual(made, [
    ["/v1/cards/1/answer", "Bearer owner-key"],
    ["/v1/events", "Bearer source-key"],
  ]);
});
test("the environment can also say writes are allowed", async () => {
  const { child, done } = mcp([], { AGENT_AUTOLOOP_MCP_ALLOW_WRITES: "1" });
  speak(child, [hello, { method: "notifications/initialized" }, list]);
  const { responses, calls: made } = await done;
  const tools = responses.find((r: any) => r.id === 2).result.tools.map((t: any) => t.name);
  assert.ok(tools.includes("answer") && tools.includes("emit"));
  assert.deepEqual(made, []);
});

// A machine that already runs a hub or worker must not lose its config when someone mistakenly calls join.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const program = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const join = (home: string, url = "https://hub.example") =>
  spawnSync(process.execPath, [program, "join", url, "--worker", "remote", "--key", "new-key", "--no-service"], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    encoding: "utf8",
    timeout: 20_000,
  });

test("join creates a worker configuration on a fresh machine", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-autoloop-join-new-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = join(home);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")), {
    url: "https://hub.example",
    worker: { name: "remote", key: "new-key" },
  });
});

for (const [name, config] of [
  ["hub", { url: "http://127.0.0.1:3350", hub: { listen: "127.0.0.1:3350" }, owner: "owner-key" }],
  ["worker", { url: "https://old-hub.example", worker: { name: "existing", key: "old-key" } }],
] as const) {
  test(`join refuses to overwrite an existing ${name} configuration`, (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "agent-autoloop-join-existing-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, "config.json");
    const original = JSON.stringify(config, null, 2) + "\n";
    writeFileSync(file, original);
    const result = join(home);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /已经配置过了/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.ok(existsSync(file));
  });
}

test("joining over plain http is only for the loopback address", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-autoloop-join-http-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const url of ["http://hub.example", "http://hub.example:3350", "http://192.168.1.5"]) {
    const refused = join(home, url);
    assert.equal(refused.status, 1, url);
    assert.match(refused.stderr, /https/, url);
    assert.ok(!existsSync(path.join(home, "config.json")), url);
  }
  for (const url of ["http://127.0.0.1:3350", "http://localhost:3350", "http://[::1]:3350"]) {
    const result = join(home, url);
    assert.equal(result.status, 0, `${url}: ${result.stderr}`);
    assert.equal(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).url, url);
    rmSync(path.join(home, "config.json"));
  }
});

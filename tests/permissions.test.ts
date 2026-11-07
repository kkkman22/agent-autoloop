// Failure modes: a master.key, config.json or hub.db readable by other users on the machine; a home other users can
// list; a mode that was wrong before left wrong; master.key or secrets.env replaced by a symlink and followed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const rules = join(import.meta.dirname, "rules.fixture.json");
const runtime = pathToFileURL(join(root, "host", "runtime.ts")).href;
const up = pathToFileURL(join(root, "host", "up.ts")).href;
const mode = (path: string) => statSync(path).mode & 0o777;
function machine(t: { after(fn: () => void): void }, name: string) {
  const home = mkdtempSync(join(tmpdir(), `agent-autoloop-perms-${name}-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function child(home: string, code: string) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], {
    cwd: root,
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: rules },
    encoding: "utf8",
    timeout: 30_000,
  });
}
test("keys, configuration, the database and the home are private, and wrong modes are tightened", (t) => {
  const home = machine(t, "modes");
  chmodSync(home, 0o755);
  // A real key's shape (43 base64url characters), only its mode is wrong: the boot must tighten it, not refuse it.
  writeFileSync(join(home, "master.key"), "k".repeat(43), { mode: 0o644 });
  writeFileSync(join(home, "config.json"), "{}", { mode: 0o644 });
  const done = child(home, `await import(${JSON.stringify(runtime)});`);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(mode(home), 0o700, "the home is listable by others");
  assert.equal(mode(join(home, "master.key")), 0o600);
  assert.equal(mode(join(home, "config.json")), 0o600);
  assert.equal(mode(join(home, "hub.db")), 0o600);
  const fresh = machine(t, "fresh");
  const made = child(fresh, `await import(${JSON.stringify(runtime)});`);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(mode(join(fresh, "master.key")), 0o600, "a new master key is private from the start");
});
test("a master.key that is a symlink is refused, not followed", (t) => {
  const home = machine(t, "keylink");
  const target = join(machine(t, "outside"), "real.key");
  writeFileSync(target, "key-material", { mode: 0o644 });
  symlinkSync(target, join(home, "master.key"));
  const done = child(home, `await import(${JSON.stringify(runtime)});`);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /master\.key 不能是符号链接/);
  assert.equal(readFileSync(target, "utf8"), "key-material", "the file it points at is left alone");
});
test("secrets.env is loaded private and can't be a symlink", (t) => {
  const home = machine(t, "secrets");
  writeFileSync(join(home, "secrets.env"), "SECRET_PROBE=from-secrets\n", { mode: 0o644 });
  const done = child(
    home,
    `const m = await import(${JSON.stringify(up)}); m.loadSecrets(); console.log("probe " + (process.env.SECRET_PROBE ?? "missing"));`,
  );
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /probe from-secrets/);
  assert.equal(mode(join(home, "secrets.env")), 0o600);
  const linked = machine(t, "secretslink");
  const target = join(machine(t, "realsecrets"), "real.env");
  writeFileSync(target, "SECRET_PROBE=taken-over\n", { mode: 0o644 });
  symlinkSync(target, join(linked, "secrets.env"));
  const refused = child(linked, `const m = await import(${JSON.stringify(up)}); m.loadSecrets();`);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /secrets\.env 不能是符号链接/);
  assert.equal(readFileSync(target, "utf8"), "SECRET_PROBE=taken-over\n", "the file it points at is left alone");
});

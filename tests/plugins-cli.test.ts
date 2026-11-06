// Failure modes: a plugin that can't run with this engine still installs; a manifest that names the plugin something
// its repository isn't slips past the loader's name rules; a name like "-bad" reaches git or the loader; installing
// records nothing, so nobody can say what version is running; remove or list invents history; update lies without
// touching anything only when asked to.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("plugins-cli");
const scratch = mkdtempSync(join(tmpdir(), "plugins-cli-src-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const LOCK = join(home, "plugins.lock.json");
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "hello",
    version: "1.2.0",
    provides: ["channel"],
    engine: ">=0.1.0 <2.0.0",
    description: "示例",
    ...over,
  });
const channelTs = "export default async function channel() {}\n";

/** A local git repository playing the role of a plugin source; no network anywhere. */
function repository(name: string, files: Record<string, string>, tags: string[] = []) {
  const dir = join(scratch, "repos", name);
  rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries(files)) {
    mkdir(path.dirname(join(dir, file)));
    writeFileSync(join(dir, file), text);
  }
  const git = (...args: string[]) => {
    const done = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
  };
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "first");
  for (const tag of tags) git("tag", tag);
  return dir;
}
function mkdir(dir: string) {
  if (!existsSync(dir)) spawnSync("mkdir", ["-p", dir]);
}
const cli = (...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
    { encoding: "utf8" },
  );
const lock = () => JSON.parse(readFileSync(LOCK, "utf8"));

test("a plugin with a manifest installs, records what it is, and lists", () => {
  const source = repository("hello", { "plugin.json": manifest(), "channel.ts": channelTs }, ["v1.2.0"]);
  const done = cli("add", source);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  const installed = lock()["hello"];
  assert.match(installed.commit, /^[0-9a-f]{40}$/);
  assert.equal(installed.version, "1.2.0");
  assert.equal(installed.signer, null);
  assert.ok(installed.at, "记录了安装时间");
  assert.ok(existsSync(join(home, "plugins", "hello", "channel.ts")));
  const list = cli("plugins", "list");
  assert.match(list.stdout, /hello/);
  assert.match(list.stdout, /1\.2\.0/);
  assert.match(list.stdout, /兼容/);
});

test("an engine this build can't satisfy is refused, and nothing is left behind", () => {
  const source = repository("future", {
    "plugin.json": manifest({ name: "future", engine: ">=99.0.0" }),
    "channel.ts": channelTs,
  });
  const done = cli("add", source);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /兼容|engine/);
  assert.equal(existsSync(join(home, "plugins", "future")), false, "克隆被删掉");
  assert.equal(lock()["future"], undefined, "没写安装记录");
});

test("a manifest naming the plugin something its repository isn't is refused", () => {
  const source = repository("misnamed", { "plugin.json": manifest({ name: "other" }), "channel.ts": channelTs });
  const done = cli("add", source);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /other|名字/);
  assert.equal(existsSync(join(home, "plugins", "misnamed")), false);
});

test("a repository whose name is not a plugin name never reaches git, and neither does a slashy manifest", () => {
  const done = cli("add", "https://example.com/-bad.git");
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /名字|小写/);
  const slashy = repository("slashy", {
    "plugin.json": manifest({ name: "a/b", version: "1.0.0" }),
    "channel.ts": channelTs,
  });
  const refused = cli("add", slashy);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /名字/);
  assert.equal(existsSync(join(home, "plugins", "slashy")), false);
});

test("remove deletes the folder and the record, and says so when nothing is there", () => {
  const source = repository("goodbye", { "plugin.json": manifest({ name: "goodbye" }), "channel.ts": channelTs });
  assert.equal(cli("add", source).status, 0);
  const done = cli("plugins", "remove", "goodbye");
  assert.equal(done.status, 0, done.stderr);
  assert.equal(existsSync(join(home, "plugins", "goodbye")), false);
  assert.equal(lock()["goodbye"], undefined);
  const again = cli("plugins", "remove", "goodbye");
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /没有|装过/);
});

test("update --check reports a newer tag without changing anything", () => {
  const source = repository(
    "pinned",
    { "plugin.json": manifest({ name: "pinned", version: "1.0.0" }), "channel.ts": channelTs },
    ["v1.0.0", "v1.3.0"],
  );
  assert.equal(cli("add", source, "--ref", "v1.0.0").status, 0, "先装 1.0.0");
  const commitAt = () => JSON.parse(readFileSync(LOCK, "utf8"))["pinned"].commit;
  const before = commitAt();
  const check = cli("plugins", "update", "pinned", "--check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /1\.3\.0/);
  assert.equal(commitAt(), before, "--check 没换版本");
});

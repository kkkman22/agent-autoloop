// Failure modes: a plugin that can't run with this engine still installs; a manifest that names the plugin something
// its repository isn't slips past the loader's name rules; a name like "-bad" reaches git or the loader; installing
// records nothing, so nobody can say what version is running; remove or list invents history; update lies without
// touching anything only when asked to; a lock or signers file written halfway, which a kill during the write leaves,
// takes the good one's place, so the write swaps a finished file in at once and leaves no spare behind.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  assert.equal(existsSync(`${LOCK}.tmp`), false, "换入后不留半截");
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

const GIT_NEW = (() => {
  const done = spawnSync("git", ["--version"], { encoding: "utf8" });
  const [major, minor] = (done.stdout.match(/git version (\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  return major > 2 || (major === 2 && minor >= 34);
})();
const SSH =
  spawnSync("ssh-keygen", ["-t", "ed25519", "-f", join(scratch, "probe"), "-N", "", "-q"], {
    encoding: "utf8",
  }).status === 0;
const signingWorks = GIT_NEW && SSH;

function signedRepository(name: string, version: string, tags: { tag: string; sign: boolean; version?: string }[]) {
  const dir = repository(name, { "plugin.json": manifest({ name, version }), "channel.ts": channelTs });
  const key = join(scratch, `${name}.key`);
  const gen = spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-q", "-C", name], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr);
  const git = (args: string[]) => {
    const done = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
  };
  for (const { tag, sign, version: at } of tags) {
    // A newer version is a new commit saying so; tags that share a commit are the same code under two names.
    if (at !== undefined) {
      writeFileSync(join(dir, "plugin.json"), manifest({ name, version: at }));
      git(["add", "."]);
      git(["-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", tag]);
    }
    const withKey = ["-c", "gpg.format=ssh", "-c", `user.signingkey=${key}.pub`];
    git(sign ? [...withKey, "tag", "-s", tag, "-m", tag] : ["tag", tag]);
  }
  return { dir, publicKey: `${key}.pub` };
}

test(
  "a trusted plugin installs and updates only through signed tags",
  { skip: !signingWorks && "需要 ssh-keygen 和 git ≥ 2.34" },
  () => {
    const { dir, publicKey } = signedRepository("audited", "1.0.0", [
      { tag: "v1.0.0", sign: true },
      { tag: "v1.2.0", sign: false },
    ]);
    assert.equal(cli("add", dir, "--ref", "v1.0.0").status, 0, "没登记时照装");
    assert.equal(lock()["audited"].signer, null);
    const trusted = cli("plugins", "trust", "audited", publicKey);
    assert.equal(trusted.status, 0, trusted.stderr);
    assert.match(trusted.stdout, /登记/);
    assert.equal(existsSync(join(home, "allowed_signers")), true);
    assert.equal(existsSync(join(home, "allowed_signers.tmp")), false, "换入后不留半截");
    assert.equal(statSync(join(home, "allowed_signers")).mode & 0o777, 0o600);

    // From here on, an unsigned version is refused and the old one keeps working.
    const unsigned = cli("add", dir, "--ref", "v1.2.0");
    assert.notEqual(unsigned.status, 0);
    assert.match(unsigned.stderr, /签名/);
    assert.match(cli("plugins", "list").stdout, /audited 1\.0\.0/);
    const updateUnsigned = cli("plugins", "update", "audited");
    assert.notEqual(updateUnsigned.status, 0);
    assert.match(updateUnsigned.stderr, /签名|留在/);
    assert.equal(lock()["audited"].version, "1.0.0", "失败的更新停在原版本");

    const escalating = signedRepository("rising", "1.0.0", [
      { tag: "v1.0.0", sign: true },
      { tag: "v1.4.0", sign: true, version: "1.4.0" },
    ]);
    assert.equal(cli("add", escalating.dir, "--ref", "v1.0.0").status, 0);
    assert.equal(cli("plugins", "trust", "rising", escalating.publicKey).status, 0);
    const updated = cli("plugins", "update", "rising");
    assert.equal(updated.status, 0, updated.stderr + updated.stdout);
    assert.match(updated.stdout, /签名人/);
    assert.equal(lock()["rising"].version, "1.4.0");
    assert.equal(lock()["rising"].signer, "rising");
  },
);

test(
  "a trusted plugin refuses a branch checkout, and only its own registered key counts",
  { skip: !signingWorks && "需要 ssh-keygen 和 git ≥ 2.34" },
  () => {
    const { dir, publicKey } = signedRepository("picky", "1.0.0", [{ tag: "v1.0.0", sign: true }]);
    const otherKey = join(scratch, "other.key");
    spawnSync("ssh-keygen", ["-t", "ed25519", "-f", otherKey, "-N", "", "-q", "-C", "other"]);
    assert.equal(cli("plugins", "trust", "picky", `${otherKey}.pub`).status, 0, "登记了一把不相干的公钥");
    const branchy = cli("add", dir);
    assert.notEqual(branchy.status, 0);
    assert.match(branchy.stderr, /版本标签|签名/);
    const trusted = cli("plugins", "trust", "picky", publicKey);
    assert.equal(trusted.status, 0);
    assert.equal(cli("add", dir, "--ref", "v1.0.0").status, 0, "登记对的钥匙后，签名的标签能装");
    assert.equal(lock()["picky"].signer, "picky");
  },
);

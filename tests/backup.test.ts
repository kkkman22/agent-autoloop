// Failure modes: the copy leaves out master.key or config.json, so nothing rebuilt from it can derive the links and
// tokens the database refers to; copying hub.db under WAL loses the newest facts, or loses the old ones when the copy
// is moved back; a manifest, a hash or the database that doesn't match still gets restored over good data; a restore
// that fails halfway leaves the home without a working database; backup, restore or rotation runs with the hub up, so
// two processes write one home; a name in the manifest reads or writes outside the backup; rotation moves the key
// without saying that every card link and the token of every run in flight stops working at once.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { credential } from "../kernel/credentials.ts";
import { openDatabase } from "../host/database.ts";
import { at, setup } from "./helpers.ts";

const home = setup("backup");
// The rules live inside the home so the backup carries them; the runtime reads that path the moment it's imported.
copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(home, "rules.json"));
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const hub = await import("../host/runtime.ts");
// A test that fails before it stops what it started must not leave the runner waiting for that process.
const children: ReturnType<typeof spawn>[] = [];
after(() => {
  for (const child of children) child.kill();
  hub.db.close();
});

const ownerKey = hub.addKey("owner", "owner");
hub.addKey("worker", "w1");
writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:3350", owner: ownerKey }, null, 2), {
  mode: 0o600,
});
writeFileSync(join(home, "secrets.env"), "AGENT_AUTOLOOP_SECRET_ECHO=s3cret\n", { mode: 0o600 });

const run = (...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
    { encoding: "utf8", env: { ...process.env } },
  );
/** The facts and the highest sequence of a home's data, read without opening the hub: the card index in it needs a key. */
const counted = (dir: string) => {
  const db = openDatabase(join(dir, "hub.db"), readFileSync(join(dir, "master.key"), "utf8").trim(), {
    readOnly: true,
  });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(seq),0) AS seq FROM facts").get()!;
    return { n: Number(row.n), seq: Number(row.seq) };
  } finally {
    db.close();
  }
};
const mode = (file: string) => statSync(file).mode & 0o777;
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const moved = () => readdirSync(home).filter((name) => name.startsWith("replaced-"));
const card = hub.tell("source:app:first", "应用", "第一件事", at(0)).card;
const row = hub.one<{ id: number; created_at: string }>("SELECT id,created_at FROM cards WHERE id=?", [card])!;
const link = hub.view({ ...row }, null, true).link!;
const linkToken = link.split("/c/")[1];

test("备份带上数据、钥匙、配置和规则，权限不松，清单对得上", () => {
  const target = join(home, "backup-one");
  const done = run("backup", target);
  assert.equal(done.status, 0, done.stderr);
  for (const name of ["hub.db", "master.key", "config.json", "secrets.env", "rules.json", "manifest.json"])
    assert.ok(existsSync(join(target, name)), name);
  assert.ok(!existsSync(join(target, "hub.db-wal")), "备份是一个一致的库文件，不是连 WAL 一起拷的");
  assert.equal(mode(target) & 0o077, 0, `${target} 不对外开`);
  for (const name of readdirSync(target)) assert.equal(mode(join(target, name)) & 0o077, 0, name);

  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
  assert.equal(manifest.made_by, "agent-autoloop");
  assert.equal(manifest.version, version);
  assert.match(manifest.commit, /^[0-9a-f]{7,40}$|^dev$/);
  assert.match(manifest.format, /^[0-9a-f]{64}$/);
  assert.deepEqual(counted(target), counted(home), "备份里的库和现在的一致");
  assert.equal(manifest.facts, counted(home).seq);
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    "config.json",
    "hub.db",
    "master.key",
    "rules.json",
    "secrets.env",
  ]);
  for (const [name, info] of Object.entries<{ bytes: number; sha256: string }>(manifest.files)) {
    assert.equal(info.sha256, sha(join(target, name)), name);
    assert.equal(info.bytes, statSync(join(target, name)).size, name);
  }

  const twice = run("backup", target);
  assert.notEqual(twice.status, 0, "同一个目录不覆盖：上一份备份不该被写坏");
  assert.equal(done.stdout.includes(target), true, done.stdout);
});

test("清单、哈希或数据库不对时拒绝恢复，原件一点不动", () => {
  const good = join(home, "backup-good");
  assert.equal(run("backup", good).status, 0);
  const before = counted(home);
  const refuse = (name: string, breakIt: (dir: string) => void) => {
    const dir = join(home, `backup-${name}`);
    cpSync(good, dir, { recursive: true });
    breakIt(dir);
    const done = run("restore", dir, "--yes");
    assert.notEqual(done.status, 0, name);
    assert.equal(done.stdout.includes("恢复好了"), false, `${name} 不该说恢复好了`);
    assert.deepEqual(counted(home), before, `${name}：原件没被动过`);
    assert.deepEqual(moved(), [], `${name}：没有挪走任何东西`);
  };
  refuse("nomanifest", (dir) => rmSync(join(dir, "manifest.json")));
  refuse("rewritten-key", (dir) => {
    const key = join(dir, "master.key");
    writeFileSync(key, `${readFileSync(key, "utf8")}\n`);
  });
  refuse("truncated", (dir) => {
    const db = join(dir, "hub.db");
    writeFileSync(db, readFileSync(db).subarray(0, 64));
  });
  refuse("stranger", (dir) => {
    const file = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.files["../../outside.json"] = manifest.files["master.key"];
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  });
  refuse("liar", (dir) => {
    const file = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.facts += 1;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  });
  assert.ok(!existsSync(join(home, "..", "outside.json")), "清单里的名字出了备份目录就被拒");
});

test("中台在跑的时候能备份，但恢复和换钥匙不动手", async () => {
  const up = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "agent-autoloop", "up"], {
    stdio: "ignore",
  });
  children.push(up);
  const stopped = new Promise((resolve) => up.on("exit", resolve));
  writeFileSync(join(home, "up.pid"), String(up.pid));
  try {
    const before = counted(home);
    const live = join(home, "backup-while-up");
    const snapped = run("backup", live);
    assert.equal(snapped.status, 0, snapped.stderr);
    assert.deepEqual(counted(live), before, "中台在跑也能拷出一致的库");
    for (const args of [
      ["restore", join(home, "backup-good"), "--yes"],
      ["key", "rotate", "--yes"],
    ]) {
      const done = run(...args);
      assert.notEqual(done.status, 0, args.join(" "));
      assert.match(done.stderr, /运行/, args.join(" "));
    }
    assert.deepEqual(counted(home), before);
    assert.deepEqual(moved(), []);
    assert.ok(
      !existsSync(join(home, "backups")) || !readdirSync(join(home, "backups")).some((n) => n.startsWith("rotate-")),
      "没换钥匙",
    );
  } finally {
    // A failing assertion above must not leave a fake hub running for the rest of the file.
    up.kill();
    await stopped;
  }
});

test("换主密钥：换之前先留一份备份，普通密钥照旧，卡片链接和轮次凭据立刻换成新的", () => {
  const before = readFileSync(join(home, "master.key"), "utf8");
  const done = run("key", "rotate", "--yes");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /链接/);
  assert.match(done.stdout, /失效/);
  const after = readFileSync(join(home, "master.key"), "utf8");
  assert.notEqual(after, before);
  assert.equal(mode(join(home, "master.key")), 0o600);

  const saved = readdirSync(join(home, "backups")).filter((name) => name.startsWith("rotate-"));
  assert.equal(saved.length, 1, "换之前那把钥匙留了下来");
  const kept = join(home, "backups", saved[0]);
  assert.equal(readFileSync(join(kept, "master.key"), "utf8"), before);
  assert.deepEqual(counted(kept), counted(home));

  const keys = run("key", "list");
  assert.equal(keys.status, 0, keys.stderr);
  assert.match(keys.stdout, /owner owner/);
  assert.match(keys.stdout, /worker w1/);
  const fresh = credential({ secret: after.trim(), publicUrl: "https://hub.test" }, "card", row.id, row.created_at);
  assert.notEqual(fresh, linkToken, "旧卡片链接不再指向这张卡片");
  assert.notEqual(
    credential({ secret: after.trim(), publicUrl: "" }, "run", 1, 1),
    credential({ secret: before.trim(), publicUrl: "" }, "run", 1, 1),
    "正在跑的轮次的凭据也跟着换",
  );
});

test("恢复回到备份时的样子，改过的数据先挪到一边，恢复后的库能用", () => {
  const target = join(home, "backup-final");
  assert.equal(run("backup", target).status, 0);
  const baseline = counted(home);
  hub.ingest("app", { id: "e-later", type: "feedback.new", subject: "later" }, at(5));
  const grown = counted(home);
  assert.ok(grown.n > baseline.n && grown.seq > baseline.seq);

  const done = run("restore", target, "--yes");
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(counted(home), baseline, "事实回到备份时的样子");
  const aside = moved();
  assert.equal(aside.length, 1, "换下来的东西在一个目录里");
  assert.deepEqual(counted(join(home, aside[0])), grown, "改过的数据没有丢");
  for (const name of ["hub.db", "master.key", "config.json", "secrets.env", "rules.json"])
    assert.equal(mode(join(home, name)) & 0o077, 0, name);
  assert.equal(mode(home) & 0o077, 0);
  assert.ok(!existsSync(join(home, "hub.db-wal")), "恢复出来的是一份干净的库");

  const listed = run("key", "list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /owner owner/);
  assert.match(listed.stdout, /worker w1/);
});

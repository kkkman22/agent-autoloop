// Backups, restores and master-key rotation for one home: the database the facts live in, the files those facts can't be
// read without, and a manifest that says which is which. A copy goes through SQLite, because a hub being written to is
// exactly what VACUUM INTO is for; a restore swaps files, so that one needs the hub stopped and says so.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "./config.ts";
import { openDatabase } from "./database.ts";
import { formatOf } from "./fingerprint.ts";
import { HOME, RULES_FILE } from "./home.ts";
import { runningUp } from "./service.ts";
import { commitOf } from "./version.ts";

// A backup holds the master key and unencrypted event text: anything this creates is its owner's alone from the start.
process.umask(0o077);

const DB_FILE = path.join(HOME, "hub.db");
const KEY_FILE = path.join(HOME, "master.key");
const SECRETS_FILE = path.join(HOME, "secrets.env");
const RULES_COPY = path.join(HOME, "rules.json");
/** Without the first three a backup is nothing to restore from. */
const REQUIRED = ["hub.db", "master.key", "config.json"];
/** Alongside them when they exist; rules.json only when it's the one in this home. */
const OPTIONAL = ["secrets.env", "rules.json"];
const KNOWN = [...REQUIRED, ...OPTIONAL];
const MANIFEST = "manifest.json";
/** The write-ahead files hold facts the main database file hasn't got yet, so a swap takes them along. */
const SIDECARS = ["hub.db-wal", "hub.db-shm"];

type FileInfo = { bytes: number; sha256: string };
export type Manifest = {
  made_by: "agent-autoloop";
  version: string;
  commit: string;
  format: string;
  facts: number;
  created_at: string;
  files: Record<string, FileInfo>;
};

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const version = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const stamp = (now: number) => new Date(now).toISOString().replace(/[:.]/g, "-");

const keyIn = (file: string) => readFileSync(file, "utf8").trim();

/** How far the facts in a database file go, without opening the hub: what a copy has to agree with its manifest about. */
function lastSeq(file: string, secret: string) {
  const db = openDatabase(file, secret, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM facts").get()!.seq);
  } catch {
    throw new Error(`读不了这个数据库，它不是这个中台的：${file}`);
  } finally {
    db.close();
  }
}

/** A consistent copy of a database someone else may be writing to right now. */
function snapshot(from: string, secret: string, to: string) {
  const db = openDatabase(from, secret);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

export function backupTo(target: string, now = Date.now()) {
  if (!existsSync(DB_FILE)) throw new Error(`这台电脑上还没有中台数据库，没东西可备份：${DB_FILE}`);
  for (const file of [KEY_FILE, CONFIG_FILE]) if (!existsSync(file)) throw new Error(`备份少不了一直在用的 ${file}`);
  // A directory of its own per backup: writing into an old one could leave it half this data and half that.
  if (existsSync(target) && readdirSync(target).length) throw new Error(`那里已经有东西了，换一个空目录：${target}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const secret = keyIn(KEY_FILE);
  snapshot(DB_FILE, secret, path.join(target, "hub.db"));
  const alongside = [KEY_FILE, CONFIG_FILE, SECRETS_FILE];
  if (path.resolve(RULES_FILE) === RULES_COPY) alongside.push(RULES_FILE);
  for (const file of alongside) {
    if (!existsSync(file)) continue;
    const copy = path.join(target, path.basename(file));
    copyFileSync(file, copy);
    chmodSync(copy, 0o600);
  }
  const manifest: Manifest = {
    made_by: "agent-autoloop",
    version: version(),
    commit: commitOf(),
    format: formatOf(secret),
    facts: lastSeq(path.join(target, "hub.db"), secret),
    created_at: new Date(now).toISOString(),
    files: Object.fromEntries(
      readdirSync(target)
        .sort()
        .map((name) => [
          name,
          { bytes: statSync(path.join(target, name)).size, sha256: sha256(path.join(target, name)) },
        ]),
    ),
  };
  writeFileSync(path.join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dir: target, manifest };
}

function check(dir: string, name: string, info: FileInfo) {
  const file = path.join(dir, name);
  // A link here would mean the directory isn't what this program wrote.
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`备份里找不到 ${name}：${file}`);
  if (statSync(file).size !== info.bytes || sha256(file) !== info.sha256) {
    throw new Error(`备份里的 ${name} 和清单对不上，可能没拷完`);
  }
}

export function readManifest(dir: string): Manifest {
  const file = path.join(dir, MANIFEST);
  if (!existsSync(file)) throw new Error(`这里没有 ${MANIFEST}，不像是一份备份：${dir}`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`清单读不了：${file}`);
  }
  if (
    manifest?.made_by !== "agent-autoloop" ||
    typeof manifest.format !== "string" ||
    !Number.isInteger(manifest.facts)
  ) {
    throw new Error(`这不是 agent-autoloop 的备份清单：${file}`);
  }
  const names = Object.keys(manifest.files ?? {}).sort();
  // Only names a backup ever writes: one from somewhere else is a reason to stop, not something to read.
  const strange = names.find((name) => !KNOWN.includes(name));
  if (strange) throw new Error(`清单里有备份不该有的东西：${strange}`);
  for (const name of REQUIRED) if (!names.includes(name)) throw new Error(`备份里缺 ${name}，恢复不了`);
  for (const name of names) check(dir, name, manifest.files[name]);
  // The copy's own key: its card index is an expression over the key its data was built with.
  const seq = lastSeq(path.join(dir, "hub.db"), keyIn(path.join(dir, "master.key")));
  if (seq !== manifest.facts) {
    throw new Error(`备份里的数据库和清单对不上：清单写了第 ${manifest.facts} 条，库里有第 ${seq} 条`);
  }
  return manifest;
}

export type Restored = { facts: number; replaced: string | null; rebuilt: boolean; keyChanged: boolean };

export function restoreFrom(dir: string, { replace, now = Date.now() }: { replace: boolean; now?: number }): Restored {
  // A hub that's up holds the database open and would keep writing into the files being swapped out from under it.
  const up = runningUp();
  if (up !== null)
    throw new Error(`中台还在运行（进程 ${up}）。先停掉它（agent-autoloop service remove），恢复完再装回来`);
  const manifest = readManifest(dir);
  const names = Object.keys(manifest.files);
  const here = [...names, ...SIDECARS].filter((name) => existsSync(path.join(HOME, name)));
  if (!replace && here.length) {
    throw new Error(
      `这里已经有一份数据（${here.join("、")}）。恢复会换掉它，旧的先挪到 ${path.join(HOME, "replaced-…")}；确认后加 --yes。`,
    );
  }
  // The backup is gathered beside the home first, and only then swapped in. While it's being copied nothing in the home
  // has moved, so a restore killed mid-copy (SIGKILL, a power cut) leaves the old data exactly where it was.
  const staged = path.join(HOME, `restore-new-${stamp(now)}`);
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  try {
    for (const name of names) {
      copyFileSync(path.join(dir, name), path.join(staged, name));
      chmodSync(path.join(staged, name), 0o600);
    }
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  let replaced: string | null = null;
  if (here.length) replaced = path.join(HOME, `replaced-${stamp(now)}`);
  let movedOut = false;
  try {
    if (replaced !== null) {
      mkdirSync(replaced, { recursive: true, mode: 0o700 });
      for (const name of here) renameSync(path.join(HOME, name), path.join(replaced, name));
    }
    movedOut = true;
    for (const name of names) renameSync(path.join(staged, name), path.join(HOME, name));
  } catch (error) {
    // Half a swap is worse than none, and only what actually moved goes back: until the move-out has finished,
    // whatever still sits in the home never left it, so clearing names would delete originals. Afterwards the home
    // holds only swapped-in copies, each cleared before its original returns.
    if (movedOut) for (const name of names) rmSync(path.join(HOME, name), { force: true });
    if (replaced !== null && lstatSync(replaced, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of readdirSync(replaced)) renameSync(path.join(replaced, name), path.join(HOME, name));
    }
    throw error;
  } finally {
    rmSync(staged, { recursive: true, force: true });
    if (
      replaced !== null &&
      lstatSync(replaced, { throwIfNoEntry: false })?.isDirectory() &&
      !readdirSync(replaced).length
    )
      rmSync(replaced, { recursive: true, force: true });
  }
  chmodSync(HOME, 0o700);
  const was = existsSync(path.join(replaced ?? "", "master.key")) ? sha256(path.join(replaced!, "master.key")) : null;
  return {
    facts: manifest.facts,
    replaced,
    rebuilt: manifest.format !== formatOf(keyIn(KEY_FILE)),
    keyChanged: was !== null && was !== sha256(KEY_FILE),
  };
}

/** A new master key. What it derives is the card links and the tokens of runs in flight, and those change with it. */
export function rotateKey(now = Date.now()) {
  const up = runningUp();
  if (up !== null) throw new Error(`中台还在运行（进程 ${up}）。先停掉它，不然两边会用两把钥匙发凭据`);
  if (!existsSync(KEY_FILE)) throw new Error(`这里还没有主密钥，启动一次中台就会生成：${KEY_FILE}`);
  if (lstatSync(KEY_FILE).isSymbolicLink()) throw new Error("master.key 不能是符号链接");
  // The old key is all that still reads what the links and tokens already handed out mean: keep it before it's gone.
  const kept = existsSync(DB_FILE) ? backupTo(path.join(HOME, "backups", `rotate-${stamp(now)}`), now).dir : null;
  const file = path.join(HOME, `.master-${randomBytes(6).toString("hex")}`);
  writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  renameSync(file, KEY_FILE);
  return { kept };
}

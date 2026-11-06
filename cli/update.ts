// Updating this install, checking for an update, and going back to the version before the last update. The install is a
// git clone; the commit an update left is remembered in the home, so going back needs nothing else.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";

const ROOT = path.join(import.meta.dirname, "..");
const REMEMBERED = () => path.join(HOME, "update.json");
/** A tag name as git allows it, and never one that starts like an option. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function git(...args: string[]) {
  const done = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
  return { ok: done.status === 0, out: (done.stdout ?? "").trim(), err: (done.stderr ?? "").trim() };
}
function must(args: string[], words: string) {
  const done = git(...args);
  if (!done.ok) throw new Error(done.err ? `${words}：${done.err}` : words);
  return done.out;
}
const here = () => must(["rev-parse", "HEAD"], "读不了现在的版本");

/** Where the newest is: the branch this follows, or the remote's default branch while a version is checked out. */
function upstream() {
  const followed = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (followed.ok && followed.out) return followed.out;
  const remote = git("rev-parse", "--abbrev-ref", "origin/HEAD");
  if (remote.ok && remote.out) return remote.out;
  throw new Error("找不到要对照的远程分支");
}

function remember(previous: string) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(REMEMBERED(), `${JSON.stringify({ previous }, null, 2)}\n`, { mode: 0o600 });
}

export function checkForUpdate() {
  must(["fetch", "--quiet", "--tags", "origin"], "连不上更新源");
  const target = upstream();
  const behind = Number(must(["rev-list", "--count", `HEAD..${target}`], "比较不了版本"));
  const newest = git("describe", "--tags", "--abbrev=0", target);
  const current = git("describe", "--tags", "--exact-match", "HEAD");
  return {
    behind,
    newest: newest.ok ? newest.out : null,
    current: current.ok ? current.out : null,
    commit: here(),
  };
}

/** To a version (a tag), or to the newest commit of the branch when no version is named. */
export function updateTo(version?: string) {
  const before = here();
  if (version !== undefined) {
    if (!VERSION.test(version)) throw new Error(`版本名不对：${version}`);
    must(["fetch", "--quiet", "origin", "tag", version], `更新源里没有 ${version}`);
    must(["checkout", "--quiet", `refs/tags/${version}`], `换不到 ${version}`);
  } else {
    // A checked-out version isn't on a branch, and pulling there has nowhere to go.
    if (!git("symbolic-ref", "-q", "HEAD").ok) {
      const branch = upstream().replace(/^origin\//, "");
      must(["checkout", "--quiet", branch], `回不到 ${branch} 分支`);
    }
    must(["pull", "--ff-only", "--quiet"], "更新失败");
  }
  const after = here();
  if (after !== before) remember(before);
  return { before, after };
}

/** Back to the commit the last update left; doing it again goes forward to where that one came from. */
export function rollBack() {
  const file = REMEMBERED();
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).previous : null;
  if (typeof previous !== "string" || !COMMIT.test(previous)) throw new Error("没有上一次更新的记录，回不去");
  const before = here();
  must(["checkout", "--quiet", previous], "回不到上一个版本");
  remember(before);
  return { before, after: previous };
}

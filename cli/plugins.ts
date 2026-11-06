// The `plugins` commands and the reworked `add`: every install records what it is, so versions and signers can be
// traced. The loader (host/plugins.ts) stays free of network and signature work; only the commands verify.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { PLUGIN_NAME, VERSION, parseManifest, readManifest, type Manifest } from "../host/plugins.ts";
import { satisfiesEngine } from "../host/semver.ts";
import { flags } from "./flags.ts";

const fail = (words: string): never => {
  console.error(words);
  process.exit(1);
};
const PLUGINS_DIR = path.join(HOME, "plugins");
const LOCK_FILE = path.join(HOME, "plugins.lock.json");
const SIGNERS_FILE = path.join(HOME, "allowed_signers");
const SEMVER_TAG = /^v?\d+\.\d+\.\d+$/;

type Install = { repo: string; ref: string; commit: string; version: string | null; signer: string | null; at: string };
type Lock = Record<string, Install>;

const thisVersion = (): string =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")).version;

function git(dir: string, args: string[]): string {
  const done = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (done.status !== 0 || done.error) fail(`git ${args[0]} 没成功：${done.stderr || done.error}`);
  return done.stdout.trim();
}

function loadLock(): Lock {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock;
  } catch {
    return {};
  }
}

function saveLock(lock: Lock) {
  mkdirSync(PLUGINS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
}

/** This name's trusted keys, as they stand in allowed_signers; an unlisted plugin installs with a note instead. */
function trustedSigners(name: string): string[] {
  try {
    return readFileSync(SIGNERS_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith(`${name} `))
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

/** Verifies `tag` against the keys registered for this plugin. Nothing registered: nothing to check. */
function verifyTag(dir: string, tag: string, name: string): string | null {
  if (!trustedSigners(name).length) return null;
  const args = ["-C", dir, "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${SIGNERS_FILE}`, "verify-tag"];
  if (spawnSync("git", [...args, tag], { encoding: "utf8" }).status !== 0)
    fail(`插件 ${name} 的 ${tag} 没通过签名验证（登记的公钥在 ${SIGNERS_FILE}）。`);
  const raw = spawnSync("git", [...args, "--raw", tag], { encoding: "utf8" });
  return /Good "git" signature for (\S+)/.exec(`${raw.stdout}${raw.stderr}`)?.[1] ?? name;
}

function checkCompatibility(manifest: Manifest, name: string) {
  if (!satisfiesEngine(thisVersion(), manifest.engine))
    throw new Error(`插件「${name}」要 engine ${manifest.engine}，当前版本 ${thisVersion()}，装不了。`);
}

/** The newest version tag in the repository, newest first by git's own version sort. */
const versionTags = (dir: string) =>
  git(dir, ["tag", "--sort=-v:refname"])
    .split("\n")
    .filter((tag) => SEMVER_TAG.test(tag));
const tagAt = (dir: string): string | undefined => {
  // No tag on HEAD is a normal answer here (a branch checkout), not a git failure to die on.
  const exact = spawnSync("git", ["-C", dir, "describe", "--tags", "--exact-match", "HEAD"], { encoding: "utf8" });
  const name = exact.stdout.trim();
  return exact.status === 0 && SEMVER_TAG.test(name) ? name : undefined;
};

/** Installs one plugin from a git repository: clone, verify manifest, engine and signature, record it. */
export function addPlugin(args: string[]) {
  const { named, rest } = flags(args);
  const url = rest[0] ?? fail("用法：agent-autoloop add <git 地址> [--ref 版本]");
  const ref = typeof named.ref === "string" ? named.ref : undefined;
  if (ref && !SEMVER_TAG.test(ref)) return fail(`版本要写成 v?数字.数字.数字 的标签：${ref}`);
  const name = url
    .replace(/\/$/, "")
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, "")
    .toLowerCase();
  if (!PLUGIN_NAME.test(name)) return fail("插件仓库名要用小写字母、数字和 -");
  const target = path.join(PLUGINS_DIR, name);
  if (existsSync(target)) return fail(`插件 ${name} 已经装在 ${target}，先 plugins remove ${name} 再装。`);
  mkdirSync(PLUGINS_DIR, { recursive: true, mode: 0o700 });
  const clone = spawnSync("git", ["clone", "--quiet", "--", url, target], { encoding: "utf8" });
  const lock = loadLock();
  try {
    if (clone.status !== 0) throw new Error(`安装失败：${clone.stderr?.trim()}`);
    if (ref) git(target, ["checkout", "--quiet", `refs/tags/${ref}`]);
    else {
      const newest = versionTags(target)[0];
      if (newest) git(target, ["checkout", "--quiet", `refs/tags/${newest}`]);
    }
    const manifest = readManifest(target);
    // A plugin without a manifest still installs (the old ones predate plugin.json); the manifest only adds checks.
    if (manifest && manifest.name !== name)
      throw new Error(`清单里的名字是「${manifest.name}」，和仓库名「${name}」不一致；仓库目录名就是插件名。`);
    if (manifest) checkCompatibility(manifest, name);
    const tag = tagAt(target);
    if (trustedSigners(name).length && !tag)
      throw new Error(`插件 ${name} 登记了签名公钥，但装的不是版本标签；用 --ref v<版本> 装一个签过名的版本。`);
    const signed = tag ? verifyTag(target, tag, name) : null;
    lock[name] = {
      repo: url,
      ref: tag ?? ref ?? git(target, ["rev-parse", "--abbrev-ref", "HEAD"]),
      commit: git(target, ["rev-parse", "HEAD"]),
      version: manifest?.version ?? null,
      signer: signed,
      at: new Date().toISOString(),
    };
    saveLock(lock);
    console.log(
      [
        `已安装 ${name}${manifest ? ` ${manifest.version}` : ""}（${lock[name].commit.slice(0, 12)}）。`,
        signed
          ? `签名人：${signed}。`
          : trustedSigners(name).length
            ? ""
            : `未登记签名公钥；要追溯来源，运行 plugins trust ${name} <公钥文件>。`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    return fail((error as Error).message);
  }
}

function list() {
  const installed = existsSync(PLUGINS_DIR)
    ? readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  if (!installed.length) return console.log("没有装过插件。");
  const lock = loadLock();
  for (const entry of installed) {
    const record = lock[entry.name];
    let line = entry.name;
    let manifest: Manifest | null = null;
    try {
      manifest = readManifest(path.join(PLUGINS_DIR, entry.name));
    } catch (error) {
      line += `　清单读不了：${(error as Error).message}`;
    }
    if (manifest) line += ` ${manifest.version}`;
    if (record) line += `　提交 ${record.commit.slice(0, 12)}　${record.signer ? `签名人 ${record.signer}` : "未签名"}`;
    else line += "　没有安装记录";
    if (manifest?.engine && !satisfiesEngine(thisVersion(), manifest.engine))
      line += `　不兼容：要 ${manifest.engine}，当前 ${thisVersion()}`;
    else line += "　兼容";
    console.log(line);
  }
}

function remove(name: string | undefined) {
  if (!name) return fail("用法：agent-autoloop plugins remove <名字>");
  const target = path.join(PLUGINS_DIR, name);
  const lock = loadLock();
  if (!existsSync(target) && !lock[name]) return fail(`没有叫 ${name} 的插件。`);
  rmSync(target, { recursive: true, force: true });
  delete lock[name];
  saveLock(lock);
  console.log(`已删除 ${name}。`);
}

/** Registers the key whose signature must be on every future version of this plugin (D7, D8). */
function trust(args: string[]) {
  const [name, keyFile] = args;
  if (!name || !keyFile || !PLUGIN_NAME.test(name)) return fail("用法：agent-autoloop plugins trust <名字> <公钥文件>");
  let publicKey: string;
  try {
    publicKey = readFileSync(keyFile, "utf8").trim();
  } catch {
    return fail(`读不了公钥文件：${keyFile}`);
  }
  if (!/^ssh-(ed25519|rsa|dss) /.test(publicKey))
    return fail("那不像一个 SSH 公钥（要以 ssh-ed25519 或 ssh-rsa 开头）。");
  const existing = trustedSigners(name).map((line) => line.split(" ").slice(1).join(" "));
  const key = publicKey.split("\n")[0];
  if (existing.includes(key)) return console.log("已经登记过这把公钥。");
  writeFileSync(SIGNERS_FILE, `${[...existing, key].map((one) => `${name} ${one}`).join("\n")}\n`, { mode: 0o600 });
  console.log(`登记了 ${name} 的签名人公钥。以后安装和更新 ${name}，都要这把钥匙签过名的版本标签。`);
}

function update(args: string[]) {
  const { named } = flags(args);
  const name = args[0];
  if (!name) return fail("用法：agent-autoloop plugins update <名字> [--check]");
  const record = loadLock()[name];
  if (!record?.version) return fail(`没有叫 ${name} 的插件、没有版本记录，或不是从插件命令装的。`);
  const target = path.join(PLUGINS_DIR, name);
  git(target, ["fetch", "--quiet", "origin", "--tags"]);
  const newer = versionTags(target).find((tag) => tag.replace(/^v/, "") !== record.version);
  if (!newer) return console.log(`已经是最新的（${record.version}）。`);
  const candidate = parseManifest(git(target, ["show", `${newer}:plugin.json`]), `${newer}:plugin.json`);
  if (candidate.name !== name) return fail(`${newer} 的清单名字是「${candidate.name}」，不是 ${name}。`);
  if (!satisfiesEngine(thisVersion(), candidate.engine))
    return console.log(`有新版本 ${newer}，但要 engine ${candidate.engine}，当前 ${thisVersion()}，先不换。`);
  if (named.check !== undefined)
    return console.log(
      `有新版本：${record.version} → ${newer.replace(/^v/, "")}。运行 plugins update ${name} 换过去。`,
    );
  const restore = git(target, ["rev-parse", "HEAD"]);
  git(target, ["checkout", "--quiet", `refs/tags/${newer}`]);
  const signed = verifyTag(target, newer, name);
  if (signed === null && trustedSigners(name).length) {
    git(target, ["checkout", "--quiet", restore]);
    return fail(`${newer} 没有签名（登记的公钥在 ${SIGNERS_FILE}），留在 ${record.version}。`);
  }
  const lock = loadLock();
  lock[name] = {
    ...record,
    ref: newer,
    commit: git(target, ["rev-parse", "HEAD"]),
    version: candidate.version,
    signer: signed ?? record.signer,
    at: new Date().toISOString(),
  };
  saveLock(lock);
  console.log(`更新好了：${record.version} → ${candidate.version}${signed ? `（签名人 ${signed}）` : ""}。`);
}

export function plugins(args: string[]) {
  const [action, ...rest] = args;
  if (action === "list" || action === undefined) return list();
  if (action === "remove") return remove(rest[0]);
  if (action === "trust") return trust(rest);
  if (action === "update") return update(rest);
  return fail(
    "用法：agent-autoloop plugins list | plugins remove <名字> | plugins trust <名字> <公钥文件> | plugins update <名字> [--check]",
  );
}

/** What doctor reports for every installed plugin: manifest, compatibility, signature. */
export function pluginReport(): { bad: string[]; notes: string[] } {
  const bad: string[] = [];
  const notes: string[] = [];
  if (!existsSync(PLUGINS_DIR)) return { bad, notes };
  const lock = loadLock();
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((one) => one.isDirectory())) {
    const name = entry.name;
    let manifest: Manifest | null = null;
    try {
      manifest = readManifest(path.join(PLUGINS_DIR, name));
    } catch (error) {
      bad.push(`插件 ${name} 的清单有问题：${(error as Error).message}`);
      continue;
    }
    if (!manifest) {
      bad.push(`插件 ${name} 没有 plugin.json 清单`);
      continue;
    }
    if (!satisfiesEngine(thisVersion(), manifest.engine))
      bad.push(`插件 ${name} ${manifest.version} 要 engine ${manifest.engine}，当前 ${thisVersion()}`);
    if (!lock[name]?.signer) notes.push(`插件 ${name} 没有登记签名的公钥（plugins trust ${name} <公钥文件>）`);
  }
  return { bad, notes };
}

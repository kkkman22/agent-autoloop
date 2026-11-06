// A plugin in this install's folder wins over one that ships.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "./home.ts";
import { validRange } from "./semver.ts";

export const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
export const VERSION = /^\d+\.\d+\.\d+$/;
const KINDS = ["agent", "channel", "source"];

/** What a plugin says about itself, in plugin.json at its repository root. */
export type Manifest = {
  name: string;
  version: string;
  provides: string[];
  engine?: string;
  description?: string;
};

/** A manifest is strict: a misspelt field would otherwise be silently ignored by whoever reads it later. */
export function parseManifest(text: string, from: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${from} 不是 JSON：${(error as Error).message}`);
  }
  const bad = (why: string): never => {
    throw new Error(`${from} ${why}`);
  };
  if (typeof parsed !== "object" || parsed === null) throw bad("要是一个对象");
  const { name, version, provides, engine, description } = parsed as Record<string, unknown>;
  if (typeof name !== "string" || !PLUGIN_NAME.test(name)) throw bad("的 name 要是插件名字：小写字母、数字和 -");
  if (typeof version !== "string" || !VERSION.test(version)) throw bad("的 version 要是 a.b.c 三个数字");
  if (!Array.isArray(provides) || !provides.every((kind) => KINDS.includes(kind as string)))
    throw bad(`的 provides 只能是 ${KINDS.join("、")} 的列表`);
  if (engine !== undefined && (typeof engine !== "string" || !validRange(engine)))
    throw bad("的 engine 只能是 >=a.b.c 和 <a.b.c 的组合");
  if (description !== undefined && typeof description !== "string") throw bad("的 description 要是文字");
  return { name, version, provides: provides as string[], engine, description };
}

/** The manifest as written, or null when the plugin has none (an old plugin still loads). A broken one is a mistake. */
export function readManifest(dir: string): Manifest | null {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) return null;
  return parseManifest(readFileSync(file, "utf8"), file);
}

export async function loadPlugin(name: string, kind: "agent" | "channel" | "source") {
  if (!PLUGIN_NAME.test(name)) throw new Error(`插件名字不正确：${name}`);
  const entry = join(name, `${kind}.ts`);
  const file = [join(HOME, "plugins", entry), join(import.meta.dirname, "..", "plugins", entry)].find(existsSync);
  if (!file) throw new Error(`没有 ${name} 的插件（plugins/${name}/${kind}.ts）`);
  return (await import(pathToFileURL(file).href)).default;
}

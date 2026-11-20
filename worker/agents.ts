// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { findOnPath } from "../host/command.ts";
import { loadPlugin } from "../host/plugins.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  /** The service tier to run at, in the agent program's own words; plugins whose program has none ignore it. */
  tier?: string;
  access: Access;
  command?: string[];
  /** The program a built-in plugin starts instead of the one it finds: a wrapper that sets things up and runs it. */
  program?: string;
  contextFile: string;
  folder: string;
};
export type Reading = {
  text?: string;
  session?: string;
  /** What this launch used. */
  usage?: Usage;
  /** What the session has used so far, for amounts the program only gives that way. */
  sessionUsage?: Usage;
  error?: string;
  /** With `error`: it's out of quota, such as a subscription's usage limit, and can take no work before this ISO time. */
  limitedUntil?: string;
  /** Its turn is over, though it may not have exited. */
  finished?: boolean;
  /** It has this turn's prompt, in a conversation that's there. From here on the work may be half done. */
  started?: boolean;
};
export type Adapter = {
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Where a person can open this session. */
  link?(session: string): string;
  /** Whether it's installed and signed in, as `program` if its rules name one: what's wrong, in words a person can act on, or nothing. */
  check?(program?: string): string | null;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

// Only hits are kept: an update can leave a program missing for a moment (`npm install -g` removes the old one
// first), and a kept miss would fail every later run until the worker restarts.
const found = new Map<string, string>();

/** The last line a shell prints for a script, or null if it fails or prints nothing. */
function shellSays(flags: string[], script: string) {
  try {
    const printed = execFileSync(process.env.SHELL ?? "/bin/sh", [...flags, script], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return printed.trim().split("\n").at(-1) || null;
  } catch {
    return null;
  }
}

/** A program on the PATH a rule's command line runs with: the login shell's on Unix. */
export function onPath(name: string) {
  if (process.platform === "win32") return findOnPath(name, [".exe", ".com", ".cmd", ".ps1"]);
  return shellSays(["-lc"], `command -v ${name}`);
}

/** A program on the PATH an interactive shell sets up: ~/.zshrc and ~/.bashrc are where installers tell people to add it. */
function inTerminal(name: string) {
  // The PATH, not `command -v`: in a terminal that can print an alias. +m: an interactive zsh with job control takes the
  // terminal's foreground and doesn't hand it back, so Ctrl-C would no longer reach the command that asked.
  const folders = shellSays(["+m", "-ic"], "printenv PATH")?.split(":") ?? [];
  // An empty entry or `.` means the folder the shell was in, not one the worker can name.
  const absolute = folders.filter((folder) => path.isAbsolute(folder));
  return absolute.map((folder) => path.join(folder, name)).find(isProgram) ?? null;
}

function isProgram(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), on the PATH a terminal sets
 * up, or in one of these.
 */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  let program = found.get(name);
  if (!program) {
    program = onPath(name) ?? (process.platform === "win32" ? null : inTerminal(name)) ?? elsewhere().find(existsSync);
    if (!program) throw new Error(`找不到 ${name}：先装好并登录`);
    found.set(name, program);
  }
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => {
  const cut = text.trim().slice(-length);
  // Slicing from the end can start inside a character: a lone trail unit there is dropped, not shown.
  return /^[\udc00-\udfff]/.test(cut) ? cut.slice(1) : cut;
};

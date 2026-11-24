// The worker: on a machine that nothing can reach, it keeps coming to the hub for work and starts an agent for each
// job. An agent runs detached, in its own process group, writing to files, so the worker can stop and come back and
// find it still going, or finished. A job is saved before anything slow happens; a result is saved before it's handed
// in and stays until the hub has taken it.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  promises as fs,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubError, type Hub } from "../protocol/client.ts";
import { HOME } from "../host/home.ts";
import { commandLine, processCommand } from "../host/command.ts";
import type { Job } from "../protocol/job.ts";
import { addUsage, dateTime, type Notice, type Result } from "../protocol/validate.ts";
import { adapterFor, type Adapter, type Reading, type Turn, type Usage } from "./agents.ts";
import { fit, promptFor, readMessage, repairPrompt, resultFrom } from "./contract.ts";
import { loadUsage, saveUsage, tidyUsage, usageDelta } from "./usage.ts";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RUNS = path.join(HOME, "worker", "runs");
const NOTHING: Usage = { input: 0, output: 0, cached: 0, cost: 0 };
const TIMEOUT_MINUTES = 180;
/** A reader of the turn's end that doesn't exit is given this long. */
const GRACE = 30_000;
/** A process told to stop is given this long. */
const STOP_GRACE = 10_000;
const REPAIRS = 2;
const KEEP_DAYS = 14;
/** A worker can run for months, so clearing can't wait for it to start again. */
const TIDY_EVERY = 60 * 60_000;
const WAIT = 50;
const PAUSE = 30_000;
const UNREACHABLE = 10 * 60_000;
/** How long a result the hub was too busy to take waits before it's handed in again. */
const BUSY_PAUSE = 30_000;
const TELL_TRIES = 5;
/** Enough of a long output to find what's at either end of it, while it runs. */
const HEAD = 64 * 1024;
const TAIL = 1024 * 1024;

type Entry = {
  run: number;
  token: string;
  attempt: number;
  job: Job;
  dir: string;
  prompt: string;
  turn: number;
  session: string;
  resume: string | null;
  repairs: number;
  triedFresh: boolean;
  usage?: Usage;
  usageBaseline?: Usage;
  pid?: number;
  launchedAt?: number;
  finishedAt?: number;
  told?: string;
  stopping?: number;
  why?: "cancel" | "timeout" | "finished";
  result?: Result;
  refusals?: number;
  retryAt?: number;
};
export type WorkerHub = Pick<Hub, "work" | "started" | "result">;
export type WorkerOptions = {
  hub: WorkerHub;
  name: string;
  capacity?: number;
  log?: (line: string) => void;
  /** Run when the hub can't be reached for ten minutes, with {text} in it: nothing else can tell the owner then. */
  unreachable?: string[];
  wait?: number;
  now?: () => number;
};

const entryFile = (dir: string) => path.join(dir, "entry.json");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** How far a launch took its session's total. One that didn't go on in that session started it from nothing. */
function sessionRise(entry: Entry, { session, sessionUsage }: Reading) {
  if (!session || !sessionUsage) return;
  saveUsage(entry.job.agent.use, session, sessionUsage);
  return usageDelta(sessionUsage, session === entry.resume ? entry.usageBaseline : NOTHING);
}

/** What the agent's environment gets: never the hub's secrets, and nothing of a session the worker itself may be in. */
function agentEnvironment(entry: Entry) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(AGENT_AUTOLOOP_|CLAUDECODE$|CLAUDE_CODE_|CODEX_(?!HOME$))/.test(name)) continue;
    env[name] = value;
  }
  return {
    ...env,
    AGENT_AUTOLOOP_HOME: HOME,
    AGENT_AUTOLOOP_RUN: String(entry.run),
    AGENT_AUTOLOOP_CONTEXT: path.join(entry.dir, "context.json"),
  };
}

const files = (entry: Entry) => ({
  out: path.join(entry.dir, `stdout-${entry.turn}.log`),
  err: path.join(entry.dir, `stderr-${entry.turn}.log`),
  exit: path.join(entry.dir, `exit-${entry.turn}`),
  command: path.join(entry.dir, `command-${entry.turn}.${process.platform === "win32" ? "json" : "sh"}`),
});
const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
const marker = (entry: Entry) => `agent-autoloop-run:${entry.run}:${entry.attempt}:${entry.turn}`;

/** Whether the run's process is still going: false when it is gone, null when we could not look. */
async function alive(entry: Entry): Promise<boolean | null> {
  if (!entry.pid) return false;
  try {
    const command = await processCommand(entry.pid);
    return command.includes(marker(entry));
  } catch (error) {
    // A process that is gone makes ps exit with status 1; anything else (EPERM, EACCES, a spawn
    // failure) means we could not look, which is not the same as it being gone.
    const status = (error as { code?: unknown }).code;
    if (process.platform !== "win32" && status === 1) return false;
    return null;
  }
}

function signal(entry: Entry, name: NodeJS.Signals, child?: ChildProcess) {
  try {
    if (child) child.kill(name);
    else if (entry.pid) process.kill(process.platform === "win32" ? entry.pid : -entry.pid, name);
  } catch {}
}

/** Whether anything in the run's group is still going, null when we could not look. */
async function groupAlive(entry: Entry): Promise<boolean | null> {
  // The wrapper can die before a child; zombies have already stopped and only their parent can reap them.
  if (!entry.pid) return false;
  if (process.platform === "win32") return alive(entry);
  try {
    // Asynchronous on purpose: the hub shares this event loop, and ps scans the whole process table.
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" });
    return stdout
      .trim()
      .split("\n")
      .some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === entry.pid && !state.startsWith("Z");
      });
  } catch {
    // ps itself may be missing or blocked in a sandbox. This group was started here, so it can be asked about
    // directly: no such group is gone, anything else means it couldn't be looked at.
    try {
      process.kill(-entry.pid, 0);
      return true;
    } catch (failure) {
      return (failure as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
    }
  }
}

function snapshot(file: string) {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  if (size <= HEAD + TAIL) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(HEAD);
    const end = Buffer.alloc(TAIL);
    readSync(fd, head, 0, HEAD, 0);
    readSync(fd, end, 0, TAIL, size - TAIL);
    return `${head.toString("utf8")}\n${end.toString("utf8")}`;
  } finally {
    closeSync(fd);
  }
}

export function createWorker({
  hub,
  name,
  capacity = 2,
  log = () => {},
  unreachable,
  wait = WAIT,
  now = Date.now,
}: WorkerOptions) {
  let claim = randomUUID();
  let unreachableSince: number | null = null;
  let told = false;
  let tries = 0;
  let blind = false;
  let tidied = -Infinity;
  let restored = false;
  let cleaning: Promise<void> | undefined;
  const active = new Map<string, Entry>();
  const supervisors = new Map<string, ChildProcess>();
  const supervisor = (entry: Entry) => {
    const child = supervisors.get(entry.dir);
    return child?.pid === entry.pid ? child : undefined;
  };
  const unreadable = new Set<string>();
  const said = new Set<string>();
  /** Trouble that lasts comes round every second, and once in the log will do. */
  const sayOnce = (line: string) => {
    if (!said.has(line)) log(line);
    said.add(line);
  };
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });

  // Whoever holds the worker may ask before its first round, and sees the runs in hand then too.
  const entries = () => {
    if (!restored) restore();
    return Array.from(active.values(), (entry) => ({ ...entry }));
  };
  const folders = async () =>
    (await fs.readdir(RUNS, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(RUNS, entry.name));

  function save(entry: Entry) {
    const file = entryFile(entry.dir);
    writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    // Keep the last persisted state even if a later update cannot be written.
    active.set(entry.dir, { ...entry });
  }

  function recoverEntry(dir: string) {
    try {
      const entry = JSON.parse(readFileSync(entryFile(dir), "utf8")) as Entry;
      if (!entry || !Number.isSafeInteger(entry.run)) throw new Error("invalid run entry");
      active.set(dir, { ...entry, dir });
      unreadable.delete(dir);
    } catch (error) {
      if (missing(error)) unreadable.delete(dir);
      else {
        unreadable.add(dir);
        sayOnce(`couldn't recover ${dir}: ${error}`);
      }
    }
  }

  /** Reads the folders once, when the worker starts or after the folder went wrong, not every round. */
  function restore() {
    active.clear();
    unreadable.clear();
    for (const entry of readdirSync(RUNS, { withFileTypes: true })) {
      if (entry.isDirectory()) recoverEntry(path.join(RUNS, entry.name));
    }
    restored = true;
  }

  /** Starts a turn of the agent: a process that outlives this one, leaving its output and exit code in files. */
  function launch(entry: Entry, adapter: Adapter, prompt: string) {
    supervisors.delete(entry.dir);
    entry.turn += 1;
    entry.launchedAt = now();
    entry.usageBaseline = entry.resume ? loadUsage(entry.job.agent.use, entry.resume) : undefined;
    delete entry.finishedAt;
    delete entry.pid;
    delete entry.stopping;
    delete entry.why;
    save(entry);
    const { rule, agent } = entry.job;
    const cwd = rule.cwd.replace(/^~(?=[/\\])/, homedir());
    const turn: Turn = {
      prompt,
      session: entry.session,
      resume: entry.resume,
      cwd,
      model: agent.model,
      effort: agent.effort,
      tier: agent.tier,
      access: agent.access as Turn["access"],
      command: agent.command,
      program: agent.program,
      contextFile: path.join(entry.dir, "context.json"),
      folder: entry.dir,
    };
    if (!existsSync(cwd)) throw new Error(`在 ${cwd} 启动不了：这个目录不存在`);
    const argv = adapter.command(turn);
    const { out, err, exit, command } = files(entry);
    if (process.platform === "win32") {
      writeFileSync(command, JSON.stringify({ argv, cwd, exit }), { mode: 0o600 });
      const output = openSync(out, "w");
      const errors = openSync(err, "w");
      try {
        const child = spawn(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            path.join(import.meta.dirname, "run.ts"),
            "--supervise",
            command,
            marker(entry),
          ],
          {
            cwd,
            env: { ...agentEnvironment(entry), AGENT_AUTOLOOP_NODE: process.execPath },
            detached: true,
            windowsHide: true,
            stdio: ["ignore", output, errors],
          },
        );
        child.on("error", (error) => log(`run ${entry.run}: ${error}`));
        child.unref();
        entry.pid = child.pid;
        if (child.pid !== undefined) supervisors.set(entry.dir, child);
      } finally {
        closeSync(output);
        closeSync(errors);
      }
      save(entry);
      log(`run ${entry.run} (${rule.name}) turn ${entry.turn} started, pid ${entry.pid}`);
      return;
    }
    // Login shells don't agree on how a command reads its arguments (fish has no $0 or $@), so the command waits in a
    // file for /bin/sh. Its path travels by environment because the install path can hold any character.
    writeFileSync(command, `unset AGENT_AUTOLOOP_COMMAND\nexec ${argv.map(quoted).join(" ")}\n`, { mode: 0o600 });
    // Output and the exit code go through the shell, so they land in their files even if this program has gone by then.
    const script = [
      "out=$1",
      "err=$2",
      "result=$3",
      "shift 3",
      "umask 077",
      '"$@" >"$out" 2>"$err"',
      'echo $? >"$result.tmp"',
      'mv "$result.tmp" "$result"',
      // A final external command can replace the shell before publishing its exit file.
      ":",
    ].join("\n");
    // The login shell gives it the PATH and sign-in its owner has in a terminal; launchd and systemd give neither.
    const login = [process.env.SHELL ?? "/bin/sh", "-lc", 'exec /bin/sh "$AGENT_AUTOLOOP_COMMAND"'];
    const child = spawn("/bin/sh", ["-c", script, marker(entry), out, err, exit, ...login], {
      cwd,
      env: { ...agentEnvironment(entry), AGENT_AUTOLOOP_COMMAND: command },
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => log(`run ${entry.run}: ${error}`));
    child.unref();
    entry.pid = child.pid;
    save(entry);
    log(`run ${entry.run} (${rule.name}) turn ${entry.turn} started, pid ${child.pid}`);
  }

  function endWith(entry: Entry, result: Result) {
    entry.result = result;
    save(entry);
  }

  async function start(job: Job) {
    const dir = path.join(RUNS, `${job.run}-${job.attempt}`);
    // Nowhere to put the run is this machine's trouble, not the hub's: said so here, and the round stays on the hub,
    // which goes "unknown" on its own when the worker stops mentioning it.
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      log(`run ${job.run}: couldn't make its folder: ${error}`);
      return;
    }
    const entry: Entry = {
      run: job.run,
      token: job.token,
      attempt: job.attempt,
      job,
      dir,
      prompt: "",
      turn: 0,
      session: job.session ?? randomUUID(),
      resume: job.session,
      repairs: 0,
      triedFresh: false,
    };
    // Kept before anything slow: a worker stopped from here on still has the job.
    save(entry);
    try {
      writeFileSync(path.join(dir, "context.json"), JSON.stringify(job.context, null, 2), { mode: 0o600 });
      const adapter = await adapterFor(job.agent.use);
      entry.prompt = promptFor(job, path.join(dir, "context.json"));
      save(entry);
      launch(entry, adapter, entry.prompt);
    } catch (error) {
      endWith(entry, { outcome: "failed", error: fit(String((error as Error).message ?? error), 500) });
    }
  }

  function read(entry: Entry, adapter: Adapter, code: number | null): Reading {
    const { out, err } = files(entry);
    try {
      const reading = adapter.read(snapshot(out), code, code === null ? "" : snapshot(err));
      if (!reading) throw new Error("它什么也没给");
      return reading;
    } catch (error) {
      sayOnce(`run ${entry.run}: couldn't read its output: ${error}`);
      // One still going goes on, since this says nothing about how it's doing. Whether one that has ended got started isn't
      // known, and starting it again in a new session could do its work twice: it stays in this one.
      return { started: true, error: `读不懂这个 Agent 的输出：${(error as Error).message ?? error}` };
    }
  }

  function discardReceipt(entry: Entry, adapter: Adapter, problem: string) {
    const original = { ...entry, turn: entry.turn - entry.repairs };
    const reading = read(original, adapter, 0);
    const { result } = resultFrom(readMessage(reading.text ?? ""), {
      session: reading.session ?? (adapter.link ? entry.session : undefined),
      usage: entry.usage,
    });
    const notice: Notice = {
      title: `「${entry.job.rule.name}」的回执读不懂`,
      text: `这一轮按第一行算结束了，但它要中台做的事没有生效（${problem}）。原文在 ${files(original).out}，留 ${KEEP_DAYS} 天。`,
    };
    endWith(entry, { ...result, notice: [...(result.notice ?? []), notice] });
  }

  /**
   * The session a run is in when its CLI hasn't said. The one made up after the old one couldn't be gone on in counts once
   * that run has started: a CLI that never got going, or one that names its own sessions, has no such session, and handing
   * it in would take the old one's place, so the retry would start over in a new one.
   */
  function madeUp(entry: Entry, adapter: Adapter, seen: Reading) {
    return adapter.link && (!entry.triedFresh || seen.started) ? entry.session : undefined;
  }

  /** A turn has ended. What it said is a result, or a reason to ask it again without redoing anything. */
  function conclude(entry: Entry, adapter: Adapter, code: number | null, unseen = false) {
    // One ended because its turn was over but it wouldn't exit said what it had to say first.
    const seen = read(entry, adapter, entry.finishedAt ? 0 : code);
    entry.usage = addUsage(addUsage(entry.usage, seen.usage), sessionRise(entry, seen));
    const session = seen.session ?? (entry.turn > 0 ? madeUp(entry, adapter, seen) : undefined);
    if (seen.session) entry.session = seen.session;
    const usage = entry.usage && { usage: entry.usage };
    const known = session && { session };
    if (entry.why === "cancel") return endWith(entry, { outcome: "cancelled", summary: "已停止", ...known, ...usage });
    if (entry.why === "timeout") {
      const minutes = entry.job.agent.timeout ?? TIMEOUT_MINUTES;
      // Past the grace period with a group that could be neither looked at nor signalled, nothing watched this run stop:
      // 已停止 there is a claim about a fact nobody observed, and it is the line the owner reads on the third failure.
      const stopped = unseen ? "停止信号发出后没能确认进程组已结束，进程可能还在" : "已停止";
      const error = `超过 ${minutes} 分钟还没结束，${stopped}`;
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      return endWith(entry, { outcome: "failed", error, ...known, ...usage });
    }
    if (seen.error !== undefined || !seen.text?.trim()) {
      const error = seen.error || "没留下结果";
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      // The conversation may not be there to go on in, or something else has it open: this go carries on in a new one.
      // Not once the turn has started: a new one would do its work again. The hub tries again later, in this one.
      // Out of quota, a new one would fail the same way.
      if (entry.resume && !entry.triedFresh && entry.repairs === 0 && !seen.started && !seen.limitedUntil) {
        log(`run ${entry.run}: couldn't go on in ${entry.resume} (${error}); starting a new session`);
        entry.triedFresh = true;
        entry.resume = null;
        entry.session = randomUUID();
        try {
          launch(entry, adapter, entry.prompt);
          return;
        } catch (failure) {
          return endWith(entry, { outcome: "failed", error: fit(String(failure), 500) });
        }
      }
      // The hub refuses a whole result with a time it can't read, and the run would wait for a result that never comes.
      const limited = dateTime(seen.limitedUntil) && { limitedUntil: seen.limitedUntil };
      return endWith(entry, { outcome: "failed", error: fit(error, 500), ...limited, ...known, ...usage });
    }
    const { result, problem } = resultFrom(readMessage(seen.text), { session, usage: entry.usage });
    if (entry.repairs && !problem && result.outcome === "failed") return discardReceipt(entry, adapter, result.error!);
    if (!problem) return endWith(entry, result);
    // Its work is done and only the receipt is wrong: it writes the receipt again, and does nothing again.
    if (entry.repairs < REPAIRS && seen.session) {
      log(`run ${entry.run}: receipt not readable (${problem}); asking again`);
      entry.repairs += 1;
      entry.resume = seen.session;
      try {
        launch(entry, adapter, repairPrompt(problem));
        return;
      } catch (error) {
        return discardReceipt(entry, adapter, String(error));
      }
    }
    discardReceipt(entry, adapter, problem);
  }

  /** Looks at a run in hand: still going, to be stopped, or ended. */
  async function check(entry: Entry) {
    if (entry.result) return;
    let adapter: Adapter;
    try {
      adapter = await adapterFor(entry.job.agent.use);
    } catch (error) {
      return endWith(entry, { outcome: "failed", error: fit(String((error as Error).message), 500) });
    }
    if (entry.turn === 0) {
      // The worker stopped while starting it, before anything was launched.
      if (!entry.prompt) entry.prompt = promptFor(entry.job, path.join(entry.dir, "context.json"));
      try {
        writeFileSync(path.join(entry.dir, "context.json"), JSON.stringify(entry.job.context, null, 2), {
          mode: 0o600,
        });
        return launch(entry, adapter, entry.prompt);
      } catch (error) {
        return endWith(entry, { outcome: "failed", error: fit(String((error as Error).message ?? error), 500) });
      }
    }
    const { exit } = files(entry);
    const exitCode = () => (existsSync(exit) ? Number(readFileSync(exit, "utf8").trim()) : null);
    const child = supervisor(entry);
    if (entry.stopping !== undefined) {
      const going = await groupAlive(entry);
      const overdue = now() - entry.stopping > STOP_GRACE;
      if (going === true) {
        if (overdue) signal(entry, "SIGKILL", child);
        return;
      }
      if (going === null) {
        // The forced kill is the last thing that can be done to it, and whether it worked can't be seen.
        if (!overdue) return;
        if (process.platform !== "win32" || child) signal(entry, "SIGKILL", child);
        // A turn that was over, or a timeout, ends on what it said: `failed` there is tried again, redoing work done.
        if (entry.why !== "cancel") return conclude(entry, adapter, exitCode(), true);
        // Reporting `cancelled` would release the item while a process may still be in it, which the protocol forbids
        // (docs/protocol.md: 确认组内没有活进程后才交 cancelled). A cancelled run's `failed` isn't tried again.
        return endWith(entry, {
          outcome: "failed",
          error: "停止信号发出后没能确认进程组已结束：这一轮按没跑成记，不再重试，进程可能还在。",
        });
      }
      return conclude(entry, adapter, exitCode());
    }
    if (existsSync(exit)) return conclude(entry, adapter, exitCode());
    // The shell can publish its exit between the first file check and ps returning.
    // A Windows supervisor started here already has a process handle and an exit watcher.
    const looking = child ? child.exitCode === null && child.signalCode === null : await alive(entry);
    if (looking === false) return conclude(entry, adapter, exitCode());
    // Unable to look, the run counts as still going, so its timeout and its finished turn still end it.
    if (looking === null && !blind) log(`couldn't inspect processes; runs count as going until they end or time out`);
    blind = looking === null;
    const seen = read(entry, adapter, null);
    // Kept as soon as it's read: if the end can't be read, the one made up at launch may be nothing its CLI knows of.
    if (seen.session && seen.session !== entry.session) {
      entry.session = seen.session;
      save(entry);
    }
    const session = seen.session ?? madeUp(entry, adapter, seen);
    if (session && session !== entry.told) {
      try {
        await hub.started(entry.run, entry.token, { session, ...(adapter.link && { link: adapter.link(session) }) });
        entry.told = session;
        save(entry);
      } catch (error) {
        log(`run ${entry.run}: couldn't say it started: ${error}`);
      }
    }
    const moment = now();
    const limit = (entry.job.agent.timeout ?? TIMEOUT_MINUTES) * 60_000;
    if (moment - (entry.launchedAt ?? moment) > limit) return stop(entry, "timeout");
    if (seen.finished) {
      // Its turn is over but it hasn't gone: whatever it's stuck on, the answer is already there.
      if (!entry.finishedAt) {
        entry.finishedAt = moment;
        save(entry);
      } else if (moment - entry.finishedAt > GRACE) {
        await stop(entry, "finished");
      }
    }
  }

  async function stop(entry: Entry, why: NonNullable<Entry["why"]>) {
    if (entry.stopping !== undefined || entry.result) return;
    entry.stopping = now();
    entry.why = why;
    save(entry);
    const child = supervisor(entry);
    if (child || process.platform !== "win32" || (await alive(entry)) === true) signal(entry, "SIGTERM", child);
    log(`run ${entry.run}: stopping (${why})`);
  }

  /** Hands in what has ended. One the hub can't take now waits for next time; one it refuses is dropped and said so. */
  async function settle(entry: Entry) {
    if (!entry.result) return;
    if (entry.retryAt !== undefined && now() < entry.retryAt) return;
    try {
      const answer = await hub.result(entry.run, entry.token, entry.result);
      for (const item of answer?.rejected ?? []) log(`run ${entry.run}: not applied: ${JSON.stringify(item)}`);
      log(`run ${entry.run}: ${entry.result.outcome}`);
      entry.refusals = undefined;
      entry.retryAt = undefined;
      save(entry);
    } catch (error) {
      if (error instanceof HubError && error.status === 429) {
        // The hub is only busy: the result is kept and comes back after a pause, so as not to add to the crowd.
        entry.retryAt = now() + BUSY_PAUSE;
        save(entry);
        return log(
          `run ${entry.run}: the hub is busy (${error.message}); keeping the result, trying again in 30 seconds`,
        );
      }
      if (error instanceof HubError && (error.status === 401 || error.status === 403)) {
        // A rotated or revoked key refuses the token for now; the finished work must not be thrown away.
        entry.refusals = (entry.refusals ?? 0) + 1;
        const wait = Math.min(5 * 60_000 * 2 ** (entry.refusals - 1), 60 * 60_000);
        entry.retryAt = now() + wait;
        save(entry);
        log(
          `run ${entry.run}: the hub didn't accept its token (${error.status}); keeping the result, retrying in ${Math.round(wait / 60_000)} minutes`,
        );
        return;
      }
      if (error instanceof HubError && error.status >= 500) {
        // The hub is the one in trouble: keep the result and come back after a pause, as a busy one is treated.
        entry.retryAt = now() + BUSY_PAUSE;
        save(entry);
        return log(
          `run ${entry.run}: the hub couldn't take the result (${error.message}); keeping it, trying again in 30 seconds`,
        );
      }
      if (!(error instanceof HubError)) {
        return log(`run ${entry.run}: couldn't hand in the result: ${error}`);
      }
      log(`run ${entry.run}: the hub refused its result (${error.status}: ${error.message}); dropped`);
    }
    try {
      unlinkSync(entryFile(entry.dir));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    active.delete(entry.dir);
    supervisors.delete(entry.dir);
  }

  /** Nothing else can tell the owner when the hub is what's gone. */
  function watchHub(reachable: boolean, moment: number) {
    if (reachable) {
      unreachableSince = null;
      told = false;
      tries = 0;
      return;
    }
    unreachableSince ??= moment;
    if (!unreachable?.length || told || tries >= TELL_TRIES || moment - unreachableSince < UNREACHABLE) return;
    tries += 1;
    const minutes = Math.floor((moment - unreachableSince) / 60_000);
    const text = `${name} 连不上中台已经 ${minutes} 分钟了，派给它的活暂时没人接；它还在一直重试。`;
    const [program, args] = commandLine(unreachable.map((part) => part.replaceAll("{text}", text)));
    try {
      execFileSync(program, args, { timeout: 60_000, stdio: "ignore" });
      told = true;
    } catch (error) {
      log(`couldn't tell anyone the hub is gone: ${error}`);
    }
  }

  /** One round: look at what's in hand, hand in what's ended, come for more. Whether the hub could be reached. */
  async function tick() {
    if (restored) {
      try {
        if (!statSync(RUNS).isDirectory()) throw new Error(`Not a directory: ${RUNS}`);
      } catch (error) {
        restored = false;
        throw error;
      }
      for (const dir of unreadable) recoverEntry(dir);
    } else restore();
    // Here and not in run: whatever drives the worker comes through here.
    const moment = now();
    if (moment - tidied >= TIDY_EVERY) void tidy(moment);
    // One reading serves the checks; the settle pass reads again, so a result whose save failed is not handed in
    // from memory alone — what is on disk is what the hub has really been given.
    const held = entries();
    for (const entry of held) {
      try {
        await check(entry);
      } catch (error) {
        sayOnce(`run ${entry.run}: ${error}`);
      }
    }
    for (const entry of entries()) {
      try {
        await settle(entry);
      } catch (error) {
        sayOnce(`run ${entry.run}: ${error}`);
      }
    }
    // Read again after settling: what is asked for now is only what is still in hand as the hub is polled.
    const inHand = entries();
    let reachable = true;
    // A hub that answers "too busy" is there: only one that doesn't answer is a reason to tell the owner.
    let answered = true;
    try {
      const answer = await hub.work({
        claim,
        wait: inHand.length ? 1 : wait,
        running: inHand.map((entry) => entry.run),
        capacity: inHand.length < capacity,
      });
      for (const id of answer?.cancel ?? []) {
        const entry = inHand.find((entry) => entry.run === id);
        if (entry) await stop(entry, "cancel");
      }
      if (answer?.job) {
        claim = randomUUID();
        await start(answer.job);
      }
    } catch (error) {
      const busy = error instanceof HubError && error.status === 429;
      log(busy ? `the hub asked this worker to slow down: ${error.message}` : `couldn't reach the hub: ${error}`);
      reachable = false;
      answered = busy;
    }
    watchHub(answered, now());
    return reachable;
  }

  /** Output of finished runs is kept a while for looking into, then goes; so are session baselines nobody resumed. */
  function tidy(moment = now()) {
    if (cleaning) return cleaning;
    tidied = moment;
    tidyUsage(moment);
    cleaning = (async () => {
      for (const dir of await folders()) {
        try {
          if (active.has(dir) || moment - (await fs.stat(dir)).mtimeMs <= KEEP_DAYS * 24 * 3600_000) continue;
          try {
            await fs.access(entryFile(dir));
            continue;
          } catch (error) {
            if (!missing(error)) throw error;
          }
          if (active.has(dir)) continue;
          await fs.rm(dir, { recursive: true, force: true });
        } catch (error) {
          if (!missing(error)) sayOnce(`couldn't clear ${dir}: ${error}`);
        }
      }
    })()
      .catch((error) => sayOnce(`couldn't list old runs: ${error}`))
      .finally(() => {
        cleaning = undefined;
      });
    return cleaning;
  }

  async function run(signalled: AbortSignal) {
    log(`worker ${name} started`);
    while (!signalled.aborted) {
      if (!(await tick())) await new Promise((resolve) => setTimeout(resolve, PAUSE));
    }
  }

  return { tick, run, entries, tidy };
}

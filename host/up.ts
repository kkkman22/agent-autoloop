// Everything this machine does, in one process: the hub, the worker and its channels, whichever config.json says. They
// speak the same protocol to each other here as they would across the world. A stop leaves agents running: they're
// detached, and the worker finds them again when it's back.
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadChannel } from "./channels.ts";
import { parseListen, readConfig, type ChannelConfig } from "./config.ts";
import { HOME } from "./home.ts";
import { limitsFrom } from "./limits.ts";
import { runningUp } from "./service.ts";
import { commitOf } from "./version.ts";
import { hubClient } from "../protocol/client.ts";
import { createWorker } from "../worker/worker.ts";

const log = (who: string) => (line: string) => console.log(`${new Date().toISOString()} [${who}] ${line}`);

/** Only one of these per install: a second would take work beside the first. */
function lock() {
  const running = runningUp();
  if (running !== null) throw new Error(`已经在跑了（进程 ${running}）`);
  const file = path.join(HOME, "up.pid");
  writeFileSync(file, String(process.pid));
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}

/** secrets.env: what an adapter needs to check a webhook, kept out of rules.json. */
export function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (!existsSync(file)) return;
  if (lstatSync(file).isSymbolicLink()) throw new Error("secrets.env 不能是符号链接");
  chmodSync(file, 0o600);
  process.loadEnvFile(file);
}

/** A channel that stops soon after it started waits this long first, twice as long each further time, up to the most. */
const FIRST_PAUSE = 5_000;
const LONGEST_PAUSE = 5 * 60_000;
/** A channel that ran this long before stopping was working: its next stop starts the pauses over. */
const STEADY = 10 * 60_000;

type ChannelDeps = {
  load?: typeof loadChannel;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  say?: (line: string) => void;
};
const pause = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => {});

/** A channel that stops for any reason is started again, later each time it stops right after starting. */
export async function keepChannelRunning(
  id: string,
  { use, key, ...options }: ChannelConfig,
  url: string,
  signal: AbortSignal,
  { load = loadChannel, now = Date.now, sleep = pause, say = log(id) }: ChannelDeps = {},
) {
  let quickStops = 0;
  while (!signal.aborted) {
    const began = now();
    let why = "returned";
    try {
      const start = await load(use ?? id);
      await start({ hub: hubClient(url, key), options, log: say, signal });
    } catch (error) {
      why = String(error);
    }
    if (signal.aborted) return;
    quickStops = now() - began >= STEADY ? 0 : quickStops + 1;
    const wait = Math.min(FIRST_PAUSE * 2 ** Math.max(quickStops - 1, 0), LONGEST_PAUSE);
    say(`stopped: ${why}; starting again in ${wait / 1000} seconds`);
    await sleep(wait, signal);
  }
}

export async function up() {
  const config = readConfig();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const unlock = lock();
  const stop = new AbortController();
  const jobs: Promise<unknown>[] = [];
  let close = () => {};
  if (config.hub) {
    loadSecrets();
    const { host, port } = parseListen(config.hub.listen);
    // A mistyped limit stops the start here: running without the limit the owner meant is worse than not running.
    const limits = limitsFrom(config.hub.limits);
    process.env.AGENT_AUTOLOOP_PUBLIC_URL = config.hub.publicUrl ?? `http://${config.hub.listen}`;
    const { serve } = await import("./http.ts");
    const say = log("hub");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      say(`${host} 不是本机回环地址，中台会向这个地址所在的网络开放；前面要有 HTTPS 反向代理`);
    }
    const server = serve(port, host, { commit: commitOf(), limits, log: say });
    server.on("listening", () => say(`listening on ${config.hub!.listen}`));
    server.on("error", (error) => {
      say(`can't listen: ${error}`);
      process.exit(1);
    });
    close = () => {
      server.close();
      server.closeAllConnections();
    };
  }
  if (config.worker) {
    const { key, name, capacity, unreachable } = config.worker;
    const worker = createWorker({ hub: hubClient(config.url, key), name, capacity, unreachable, log: log("worker") });
    jobs.push(worker.run(stop.signal));
  }
  for (const [id, channel] of Object.entries(config.channels ?? {})) {
    jobs.push(keepChannelRunning(id, channel, config.url, stop.signal));
  }
  const finish = () => {
    stop.abort();
    close();
    unlock();
    process.exit(0);
  };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  await Promise.all(jobs);
}

// What the kernel's doors need from this machine: the clock, a timer for the next deadline, long polls to wake, the
// rules file to watch, the log as a stream and the webhook plugins.
import { realpathSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { RULES_FILE } from "./home.ts";
import { createLimiter, type Limits } from "./limits.ts";
import { metricsText } from "./metrics.ts";
import { loadPlugin } from "./plugins.ts";
import * as hub from "./runtime.ts";
import { PAGE_HEADERS, wordsPage } from "../kernel/card-page.ts";
import { whose } from "../kernel/credentials.ts";
import { AuthError, InputError, NotFound } from "../kernel/errors.ts";
import { createHandler } from "../kernel/http.ts";

/** Past this setTimeout fires at once. */
const LONGEST_TIMER = 2147483647;
const TICK_RETRY = 5_000;
/** A turned-away upload is read this far before answering: answering mid-write resets the caller's connection. */
const DRAIN = 8 * 1024 * 1024;
const DRAIN_MS = 5_000;
const KINDS = ["owner", "worker", "channel", "source"];

/** Who is asking, for counting: a key's holder, a run, a webhook's source, card links, or one name for every guess. */
function callerOf(request: Request) {
  const { pathname } = new URL(request.url);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token) {
    const hook = /^\/v1\/in\/([a-z][a-z0-9-]*)$/.exec(pathname);
    if (hook) return `in:${hook[1]}`;
    return pathname.startsWith("/c/") ? "link" : "anyone";
  }
  const view = hub.getView();
  for (const kind of KINDS) {
    const name = whose(view, kind, token);
    if (name) return `${kind}:${name}`;
  }
  const run = /^\/v1\/runs\/([1-9][0-9]*)\/(started|result)$/.exec(pathname);
  return run ? `run:${run[1]}` : "guess";
}

async function drain(request: Request) {
  if (!request.body) return;
  const reader = request.body.getReader();
  let timer: NodeJS.Timeout | undefined;
  // A refused caller isn't counted any more, so an upload that never ends must not keep it here either.
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, DRAIN_MS, null);
  });
  let size = 0;
  try {
    while (size <= DRAIN) {
      const next = await Promise.race([reader.read(), late]);
      if (!next || next.done) return;
      size += next.value.length;
    }
  } catch {
  } finally {
    clearTimeout(timer);
  }
}

function tooMany(request: Request, reason: string, retryAfter: number) {
  const message = `请求太多了（${reason}），${retryAfter} 秒后再试`;
  const headers = { "retry-after": String(retryAfter), "cache-control": "no-store" };
  if (new URL(request.url).pathname.startsWith("/c/")) {
    return new Response(wordsPage(message), { status: 429, headers: { ...PAGE_HEADERS, ...headers } });
  }
  return Response.json({ error: message }, { status: 429, headers });
}

function logStream(after: number, signal: AbortSignal, key: string) {
  let position = after;
  let unsubscribe = () => {};
  let stop = () => {};
  const detach = () => {
    unsubscribe();
    signal.removeEventListener("abort", stop);
  };
  let send = () => {};
  let stopped = false;
  return new ReadableStream({
    start(controller) {
      stop = () => {
        if (stopped) return;
        stopped = true;
        detach();
        controller.close();
      };
      send = () => {
        if (stopped) return;
        if (!hub.whose("owner", key)) return stop();
        if (controller.desiredSize! <= 0) return;
        for (const fact of hub.logAfter(position, 1)) {
          position = fact.seq;
          const message = `id: ${fact.seq}\nevent: fact\ndata: ${JSON.stringify(fact)}\n\n`;
          controller.enqueue(new TextEncoder().encode(message));
        }
      };
      unsubscribe = hub.onChange(send);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    },
    pull() {
      send();
    },
    cancel() {
      stopped = true;
      detach();
    },
  });
}

async function adaptWebhook(source: string, headers: Headers, body: string) {
  const adapter = hub.rules.sources[source]?.adapter;
  if (!adapter || !/^[a-z][a-z0-9-]*$/.test(adapter)) throw new NotFound("这个来源不收 Webhook");
  const translate = await loadPlugin(adapter, "source");
  const secret = process.env[`AGENT_AUTOLOOP_SECRET_${source.toUpperCase().replaceAll("-", "_")}`] ?? "";
  // An adapter says "a stranger" by refusing; plugins can't import the engine's own error to say it themselves.
  // Anything else it throws reads as a payload it couldn't read: the caller is signed, so it gets the reason as 400.
  const refuse = (why = "验签没过"): never => {
    throw new AuthError(why);
  };
  try {
    const events = translate({ headers: Object.fromEntries(headers), body, secret, refuse });
    return Array.isArray(events) ? events : [];
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new InputError(`适配器读不了这个请求：${(error as Error).message}`.slice(0, 300));
  }
}

export type HandlerOptions = { commit?: string; limits?: Limits; log?: (line: string) => void };

export function makeHandler(commit = "dev", { limits, log = () => {} }: HandlerOptions = {}) {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let retryAt: number | undefined;
  const waiting = new Set<{ until: number; done: () => void }>();
  const wake = () => {
    for (const waiter of [...waiting]) waiter.done();
  };
  const fire = () => {
    try {
      hub.tick();
      retryAt = undefined;
    } catch (error) {
      // Another process holding the database too long, say. Nobody is there to catch it, and what it brought is still due.
      console.error(error);
      retryAt = Date.now() + TICK_RETRY;
    }
    wake();
    arm();
  };
  const arm = () => {
    clearTimeout(timer);
    if (closed) return;
    const due = hub.one<{ at: number }>(
      "SELECT MIN(json_extract(data, '$.at')) AS at FROM projections WHERE collection='due'",
    );
    // Whatever the failed tick left is overdue, so it would go at once; and nothing else coming along may lose the retry.
    const next = retryAt ?? Math.min(due?.at ?? Infinity, ...[...waiting].map((waiter) => waiter.until));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(fire, Math.max(0, Math.min(LONGEST_TIMER, next - Date.now())));
  };
  const unlisten = hub.onChange((type, facts) => {
    // Being seen wakes nobody, unless it changed a card.
    const justSeen = type === "heartbeat" || type === "channelSeen";
    if (!justSeen || facts.some((fact) => fact.changes.some((change) => change.table === "cards"))) wake();
    arm();
  });
  // libuv 1.52 (Node 24.16+) on Windows asserts and exits on the first change in a folder named through an 8.3 short name.
  const watcher = watch(realpathSync.native(dirname(RULES_FILE)), (_event, file) => {
    if (file === basename(RULES_FILE)) fire();
  });
  const handle = createHandler({
    commit,
    now: Date.now,
    view: hub.getView,
    environment: hub.environment,
    dispatch: hub.execute,
    state: hub.stateOf,
    why: hub.why,
    metrics: () => metricsText(commit),
    card: hub.cardByToken,
    wait(until, signal) {
      return new Promise((resolve) => {
        const waiter = {
          until,
          done() {
            waiting.delete(waiter);
            signal.removeEventListener("abort", waiter.done);
            resolve();
          },
        };
        waiting.add(waiter);
        signal.addEventListener("abort", waiter.done, { once: true });
        if (signal.aborted) waiter.done();
        arm();
      });
    },
    stream: logStream,
    adapt: adaptWebhook,
  });
  fire();
  const admit = limits && createLimiter(limits, log);
  return {
    async handle(request: Request) {
      if (!admit) return handle(request);
      const admitted = admit(callerOf(request), new URL(request.url).pathname);
      if ("reason" in admitted) {
        await drain(request);
        return tooMany(request, admitted.reason, admitted.retryAfter);
      }
      // The Node server aborts every request's signal once its answer is over, a long poll or a stream included.
      request.signal.addEventListener("abort", admitted.release, { once: true });
      if (request.signal.aborted) admitted.release();
      return handle(request);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      unlisten();
      wake();
    },
  };
}

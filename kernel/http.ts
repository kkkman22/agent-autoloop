// The doors: every request the hub takes, which key it asks for, and which input it becomes. Nothing is decided here.
import { cardPage, PAGE_HEADERS, wordsPage } from "./card-page.ts";
import { whose, type Environment } from "./credentials.ts";
import { decide } from "./decide.ts";
import { AuthError, Conflict, Gone, InputError, NotFound } from "./errors.ts";
import { rows, type Row, type View } from "./evolve.ts";
import { agentsOf, cancels, cardView, configuration, eventOutcome } from "./query.ts";
import { type Rule, type Rules } from "./rules.ts";
import { parseRules, RulesError } from "../protocol/rules.ts";
import { isAsk } from "../protocol/validate.ts";

export type Services = {
  now(): number;
  view(): View;
  environment: Environment;
  commit: string;
  dispatch(type: string, args: any[], now: number): any;
  state(now: number, before?: number): unknown;
  why(id: number): unknown;
  metrics(): string;
  card(token: string): Row | undefined;
  wait(until: number, signal: AbortSignal): Promise<void>;
  stream(after: number, signal: AbortSignal, key: string): ReadableStream;
  adapt(source: string, headers: Headers, body: string): Promise<unknown[]>;
};

const MAX_BODY = 1024 * 1024;
const MAX_WAIT_SECONDS = 50;
const LINK_LIFETIME = 7 * 86400_000;
const CARD_LINK = /^\/c\/([A-Za-z0-9_-]{1,64})$/;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const KEY_HOLDERS: Record<string, string> = { owner: "本人", worker: "接单程序", channel: "通道", source: "来源" };
const NO_STORE = { "cache-control": "no-store" };

class TooLarge extends Error {}

async function readText(request: Request) {
  if (!request.body) return "";
  // A little over the limit is read to its end: hanging up mid-upload can cost the client its 413.
  if (Number(request.headers.get("content-length")) > 8 * MAX_BODY) throw new TooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size <= MAX_BODY) chunks.push(value);
    // Keep draining a while past the limit: answering while the sender is still writing resets the socket, and the
    // reset takes down whatever request that client sends next on the same connection.
    if (size > 8 * MAX_BODY) throw new TooLarge();
  }
  if (size > MAX_BODY) throw new TooLarge();
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: Request) {
  const text = await readText(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("不是 JSON");
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_STORE });
function statusOf(error: unknown) {
  if (error instanceof TooLarge) return 413;
  if (error instanceof InputError || error instanceof RulesError) return 400;
  if (error instanceof AuthError) return 401;
  if (error instanceof Conflict) return 409;
  if (error instanceof NotFound) return 404;
  if (error instanceof Gone) return 410;
  return 500;
}

function callFrom(services: Services, request: Request) {
  const url = new URL(request.url);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const now = services.now();
  const view = services.view();
  return { services, request, url, token, now, view, rules: configuration(view) };
}
type Call = ReturnType<typeof callFrom>;

const keyHolder = (call: Call, kind: string) => whose(call.view, kind, call.token);
const act = (call: Call, type: string, ...args: any[]) => call.services.dispatch(type, args, call.services.now());

function requireKey(call: Call, kind: string) {
  const holder = keyHolder(call, kind);
  if (!holder) throw new AuthError(`要${KEY_HOLDERS[kind]}自己的密钥`);
  return holder;
}

function ownerAct(call: Call, type: string, ...args: any[]) {
  requireKey(call, "owner");
  act(call, type, ...args);
  return json({ ok: true });
}

/** When a long poll gives up: as long as it asked to wait, up to the most anyone gets. */
function waitUntil(call: Call) {
  const seconds = Number(call.url.searchParams.get("wait") ?? MAX_WAIT_SECONDS) || 0;
  return call.now + Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1000;
}

async function cardAtLink(call: Call, linkToken: string) {
  const { rules, request } = call;
  const { environment } = call.services;
  const card = call.services.card(linkToken);
  const linksInUse = Object.values(rules.channels).some((channel) => channel.links);
  if (!card || !linksInUse) throw new NotFound("没有这张卡片");
  if (call.now - Date.parse(card.created_at) > LINK_LIFETIME) {
    throw new Gone(`这个链接过期了。在装它的电脑上运行 agent-autoloop answer ${card.id} 回答`);
  }
  if (request.method === "GET") return new Response(cardPage(cardView(card, environment)), { headers: PAGE_HEADERS });
  // A link proves holding the link, not who holds it: a card that names its answerers takes none from here.
  if (Array.isArray(card.answerers)) {
    throw new AuthError("这张卡片只允许指定的人回答，链接证明不了是谁；请在通道里回答");
  }
  const form = new URLSearchParams(await readText(request));
  const choice = form.has("choice") && { choice: Number(form.get("choice")) };
  act(call, "answer", card.id, { ...choice, text: form.get("text") ?? undefined, by: "链接" });
  return new Response(null, { status: 303, headers: { location: call.url.pathname, ...NO_STORE } });
}

async function webhook(call: Call, source: string) {
  if (!call.rules.sources[source]?.adapter) throw new NotFound("这个来源不收 Webhook");
  const events = await call.services.adapt(source, call.request.headers, await readText(call.request));
  return json({ events: events.map((event) => act(call, "ingest", source, event)) });
}

async function tell(call: Call) {
  const { rules } = call;
  const source = keyHolder(call, "source");
  const worker = source ? null : keyHolder(call, "worker");
  if (!source && !worker) throw new AuthError("要来源或接单程序的密钥");
  const input = await readJson(call.request);
  // A task elsewhere either tells you something or asks you, with a question just as a receipt's.
  if (worker && input && typeof input === "object" && "ask" in input) return askAsTask(call, worker, input);
  const expected = source ? ["key", "text"] : ["key", "task", "text"];
  const hasExpected = input && typeof input === "object" && Object.keys(input).sort().join() === expected.join();
  const keyIsValid = typeof input?.key === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.key);
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (!hasExpected || !keyIsValid || !text || [...text].length > 20_000) {
    throw new InputError("要有正确的 key 和 text，接单程序还要写 task，text 最多 20000 字；问你的写 task 和 ask");
  }
  if (source) {
    return json(act(call, "tell", `source:${source}:${input.key}`, rules.sources[source]?.name ?? source, text));
  }
  const task = taskOf(call, worker!, input.task);
  return json(act(call, "tell", `elsewhere:${task.name}:${input.key}`, task.name, text));
}

function taskOf({ rules, view }: Call, worker: string, name: unknown) {
  const task = rules.elsewhere.find((task) => task.name === name && agentsOf(view, worker).includes(task.to));
  if (!task) throw new AuthError("这台接单程序没有这个定时任务");
  return task;
}

function askAsTask(call: Call, worker: string, input: Record<string, any>) {
  if (Object.keys(input).sort().join() !== "ask,task" || !isAsk(input.ask)) {
    throw new InputError("问你的只写 task 和 ask，ask 和回执里的一样：title、text、2 到 5 个 options");
  }
  return json(act(call, "ask", taskOf(call, worker, input.task).name, input.ask));
}

async function work(call: Call) {
  const { services, request, url, token } = call;
  const worker = requireKey(call, "worker");
  const claim = url.searchParams.get("claim") ?? "";
  if (!claim || claim.length > 200) throw new InputError("claim 是这次领活的编号，最多 200 字");
  const running = (url.searchParams.get("running") ?? "").split(",").filter((id) => POSITIVE_ID.test(id));
  act(call, "heartbeat", worker, running.map(Number));
  const until = waitUntil(call);
  for (;;) {
    if (!whose(services.view(), "worker", token)) throw new AuthError("密钥已失效");
    const wantsWork = !request.signal.aborted && url.searchParams.get("capacity") !== "0";
    const job = wantsWork ? act(call, "claimNext", worker, claim) : null;
    const cancel = cancels(services.view(), worker);
    if (job || cancel.length || services.now() >= until || request.signal.aborted) return json({ job, cancel });
    await services.wait(until, request.signal);
  }
}

async function nextCard(call: Call) {
  const { services, request, token } = call;
  const channel = requireKey(call, "channel");
  if (!Object.hasOwn(call.rules.channels, channel)) throw new NotFound("这个通道没有在 rules.json 里登记");
  const until = waitUntil(call);
  act(call, "channelSeen", channel);
  for (;;) {
    if (!whose(services.view(), "channel", token)) throw new AuthError("密钥已失效");
    const card = request.signal.aborted ? null : act(call, "nextCard", channel);
    if (card || services.now() >= until || request.signal.aborted) return json({ card });
    await services.wait(until, request.signal);
  }
}

async function cardAction(call: Call, id: number, action: string) {
  const channel = keyHolder(call, "channel");
  requireKey(call, action === "resolve" || (action === "answer" && !channel) ? "owner" : "channel");
  const given = await readJson(call.request);
  if (action === "resolve") {
    const reason = given?.reason;
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) {
      throw new InputError("写一句处理结果，最多 1000 字");
    }
    return json({ changed: act(call, "resolve", id, reason.trim(), "本人") });
  }
  if (action === "answer") {
    const who = channel ? { by: given?.by, ref: given?.ref, channel } : { by: "本人" };
    return json(act(call, "answer", id, { choice: given?.choice, text: given?.text, ...who }));
  }
  if (!Number.isInteger(given?.version)) throw new InputError("要说明是哪个版本");
  const ref = typeof given.ref === "string" ? given.ref : null;
  act(call, action, channel, id, given.version, action === "delivered" ? ref : String(given.error ?? ""));
  return json({ ok: true });
}

const CONTROL_FIELDS: Record<string, string[]> = { pause: ["reason", "until"], resume: [], run: ["subject", "reason"] };
const CONTROL_INPUTS: Record<string, string> = { pause: "pauseRule", resume: "resumeRule", run: "runRule" };

/** Pause, resume or run a rule now: the owner's, kept in the log. */
async function control(call: Call, encoded: string, action: string) {
  const holder = requireKey(call, "owner");
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    throw new InputError("名字不正确");
  }
  const text = await readText(call.request);
  let given: unknown = {};
  try {
    if (text.trim()) given = JSON.parse(text);
  } catch {
    throw new InputError("不是 JSON");
  }
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new InputError("要是一个 JSON 对象");
  const unknown = Object.keys(given).filter((field) => !CONTROL_FIELDS[action].includes(field));
  if (unknown.length) throw new InputError(`不认识的字段：${unknown.join("、")}`);
  const type = CONTROL_INPUTS[action];
  return json(action === "resume" ? act(call, type, name) : act(call, type, name, holder, given));
}

function state(call: Call) {
  requireKey(call, "owner");
  const before = call.url.searchParams.get("before");
  if (before !== null && !POSITIVE_ID.test(before)) throw new InputError("编号不正确");
  return json(call.services.state(call.now, before === null ? undefined : Number(before)));
}

function stream(call: Call) {
  const { request, services, token } = call;
  requireKey(call, "owner");
  const after = call.url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new InputError("日志序号不正确");
  const headers = { "content-type": "text/event-stream", ...NO_STORE, "x-accel-buffering": "no" };
  return new Response(services.stream(Number(after), request.signal, token), { headers });
}

function metrics(call: Call) {
  requireKey(call, "owner");
  return new Response(call.services.metrics(), {
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

async function route(call: Call): Promise<Response> {
  const { request, services, token } = call;
  const { method } = request;
  const path = call.url.pathname;
  if (method === "GET" && path === "/healthz") return json({ ok: true, commit: services.commit });
  // A key's name is whatever `key new` was given; it only has to stay one path segment when encoded.
  const key = /^\/v1\/keys\/(source|worker|channel|owner)\/([^/]+)$/.exec(path);
  if (method === "DELETE" && key) {
    requireKey(call, "owner");
    let name: string;
    try {
      name = decodeURIComponent(key[2]);
    } catch {
      throw new InputError("密钥名字不正确");
    }
    return json({ ok: true, changed: act(call, "removeKey", key[1], name) });
  }
  const link = CARD_LINK.exec(path);
  if (link && ["GET", "POST"].includes(method)) return cardAtLink(call, link[1]);
  const hook = /^\/v1\/in\/([a-z][a-z0-9-]*)$/.exec(path);
  if (method === "POST" && hook) return webhook(call, hook[1]);
  if (method === "POST" && path === "/v1/events") {
    return json(act(call, "ingest", requireKey(call, "source"), await readJson(request)));
  }
  const sent = /^\/v1\/events\/([1-9][0-9]*)$/.exec(path);
  if (method === "GET" && sent) {
    // Another source's event is as missing as one never sent: a source can't learn which numbers are taken.
    const found = eventOutcome(call.view, requireKey(call, "source"), Number(sent[1]));
    if (!found) throw new NotFound("没有这条事件");
    return json(found);
  }
  if (method === "POST" && path === "/v1/tell") return tell(call);
  if (method === "GET" && path === "/v1/work") return work(call);
  const [, runPart, action] = /^\/v1\/runs\/([1-9][0-9]*)\/(started|result|cancel|why)$/.exec(path) ?? [];
  const runId = Number(runPart);
  if (method === "GET" && action === "why") {
    requireKey(call, "owner");
    return json(services.why(runId));
  }
  if (method === "POST" && action === "cancel") return ownerAct(call, "cancel", runId);
  if (method === "POST" && action === "started") {
    act(call, "started", runId, token, await readJson(request));
    return json({ ok: true });
  }
  if (method === "POST" && action === "result") return json(act(call, "finish", runId, token, await readJson(request)));
  if (method === "GET" && path === "/v1/cards/next") return nextCard(call);
  const card = /^\/v1\/cards\/([1-9][0-9]*)\/(delivered|failed|answer|resolve)$/.exec(path);
  if (method === "POST" && card) return cardAction(call, Number(card[1]), card[2]);
  const ruleControl = /^\/v1\/rules\/([^/]+)\/(pause|resume|run)$/.exec(path);
  if (method === "POST" && ruleControl) return control(call, ruleControl[1], ruleControl[2]);
  if (method === "GET" && path === "/v1/state") return state(call);
  if (method === "POST" && path === "/v1/rules/preview") {
    requireKey(call, "owner");
    // The body is the candidate rules file itself; a preview decides on a fork of the view and commits nothing.
    const candidate = parseRules(await readText(request), call.now, call.rules.timezone);
    return json(previewRules(call.view, candidate, call.now, call.services.environment));
  }
  if (method === "GET" && path === "/v1/metrics") return metrics(call);
  if (method === "GET" && path === "/v1/stream") return stream(call);
  return json({ error: "没有这个地址" }, 404);
}

export function createHandler(services: Services) {
  return async function handle(request: Request): Promise<Response> {
    const call = callFrom(services, request);
    try {
      return await route(call);
    } catch (error) {
      const status = statusOf(error);
      if (status === 500) throw error;
      const message = error instanceof TooLarge ? "请求最多 1024 KB" : (error as Error).message;
      if (CARD_LINK.test(call.url.pathname)) return new Response(wordsPage(message), { status, headers: PAGE_HEADERS });
      return json({ error: message }, status);
    }
  };
}

export type Preview = {
  added: string[];
  removed: string[];
  renamed: { from: string; to: string }[];
  changed: string[];
  cancels: { rule: string; count: number; runs: number[] }[];
  closes: { rule: string; count: number; cards: { id: number; title: string }[] }[];
  claimed: { run: number; rule: string }[];
};
const WITHOUT_NAME = (rule: Rule) => JSON.stringify({ ...rule, name: null });
const CAP = 20;

/** What applying these rules would do: decided on a fork of the view and never committed, so reading writes nothing. */
export function previewRules(view: View, candidate: Rules, now: number, env: Environment): Preview {
  const current = configuration(view);
  const before = new Map(current.rules.map((rule) => [rule.name, rule]));
  const after = new Map(candidate.rules.map((rule) => [rule.name, rule]));
  const added: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const changed: string[] = [];
  for (const [name, rule] of after) {
    const old = before.get(name);
    if (old === undefined) {
      const twin = [...before].find(([, other]) => WITHOUT_NAME(other) === WITHOUT_NAME(rule));
      if (twin) renamed.push({ from: twin[0], to: name });
      else added.push(name);
    } else if (WITHOUT_NAME(old) !== WITHOUT_NAME(rule)) changed.push(name);
  }
  const removed = [...before.keys()].filter((name) => {
    const twin = [...after].find(([, rule]) => WITHOUT_NAME(rule) === WITHOUT_NAME(before.get(name)!));
    return !after.has(name) && !twin;
  });
  const { facts } = decide(view, { type: "rules", args: [candidate] }, now, env);
  const cancels = new Map<string, { count: number; runs: number[] }>();
  const closes = new Map<string, { count: number; cards: { id: number; title: string }[] }>();
  for (const fact of facts)
    for (const { table, key, row } of fact.changes) {
      if (row === null) continue;
      // A queued run is stopped with the rule's own words (不在了), one already in hand by dropRules (已删除).
      if (table === "runs" && row.state === "cancelled" && /规则.*(已删除|不在了)/.test(String(row.summary ?? ""))) {
        const entry = cancels.get(row.rule) ?? { count: 0, runs: [] };
        entry.count += 1;
        if (entry.runs.length < CAP) entry.runs.push(Number(key));
        cancels.set(row.rule, entry);
      }
      if (table === "cards" && row.state === "closed" && row.result === "对应规则已删除") {
        const entry = closes.get(row.rule) ?? { count: 0, cards: [] };
        entry.count += 1;
        if (entry.cards.length < CAP) entry.cards.push({ id: Number(key), title: row.title });
        closes.set(row.rule, entry);
      }
    }
  const kept = new Set(after.keys());
  const claimed = rows(view, "runs", { state: "claimed" })
    .filter((run) => !kept.has(run.rule))
    .map((run) => ({ run: run.id, rule: run.rule }));
  return {
    added,
    removed,
    renamed,
    changed,
    cancels: [...cancels].map(([rule, { count, runs }]) => ({ rule, count, runs })),
    closes: [...closes].map(([rule, { count, cards }]) => ({ rule, count, cards })),
    claimed,
  };
}

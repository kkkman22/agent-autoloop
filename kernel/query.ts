// Reading the view: what the decisions and the doors ask of it, and the shapes they hand out.
import { credential, type Environment } from "./credentials.ts";
import { decide } from "./decide.ts";
import { rows, type Fact, type Row, type View } from "./evolve.ts";
import type { Job } from "../protocol/job.ts";
import type { Rule, Rules } from "./rules.ts";

export function configuration(view: View, version?: number): Rules {
  const current = view.get("config", "rules");
  return (version === undefined || version === current?.version ? current : view.get("config", version))?.value;
}
export const workerOf = (view: View, run: Row) => configuration(view, run.rules_version).agents[run.agent]?.worker;
export function agentsOf(view: View, worker: string) {
  const agents = Object.entries(configuration(view).agents);
  return agents.filter(([, agent]) => agent.worker === worker).map(([id]) => id);
}
export const workers = (view: View) =>
  new Set([
    ...Object.values(configuration(view)?.agents ?? {}).map((agent) => agent.worker),
    ...rows(view, "runs", { state: "claimed" }).map((run) => workerOf(view, run)!),
  ]);

/** What a worker's agents have on: runs in hand and runs ready to be claimed. */
export function waitingOn(view: View, worker: string, now: number) {
  const ready = (run: Row) => run.state === "queued" && Date.parse(run.not_before) <= now;
  return rows(view, "runs", { state: ["queued", "claimed"] }).filter(
    (run) => workerOf(view, run) === worker && (run.state === "claimed" || ready(run)),
  );
}

export function eventsOf(view: View, runId: number) {
  const links = rows(view, "run_events", { run_id: runId });
  return links.map((link) => view.get("events", link.event_id)!).sort((a, b) => a.id - b.id);
}

export function sourceOf(view: View, runId: number) {
  const sources = [...new Set(eventsOf(view, runId).map((event) => event.source))];
  return sources.length === 1 ? sources[0] : null;
}

/** The cards a run may close: open before it was claimed, from the same source and group. */
export function openInScope(view: View, run: Row) {
  const source = sourceOf(view, run.id);
  if (!source || !run.claimed_at) return [];
  const inScope = (card: Row) => card.grp === run.grp && card.source === source && card.created_at <= run.claimed_at;
  return rows(view, "cards", { state: "open", grp: run.grp, source }).filter(inScope);
}

export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  const { id, version, kind, state, title, text, recommend, choice, answer, by, result } = card;
  const options: string[] = kind === "ask" ? JSON.parse(card.options) : state === "open" ? ["已处理"] : [];
  const link = links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", id, card.created_at)}` : null;
  const when = { createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at };
  return {
    id,
    version,
    ref,
    kind,
    state,
    title,
    text,
    options,
    recommend,
    choice,
    answer,
    by,
    result,
    link,
    rule: card.rule,
    ...when,
  };
}

export function jobOf(view: View, run: Row, env: Environment): Job {
  const rules = configuration(view, run.rules_version);
  const { name, cwd, skill, prompt, emits } = rules.rules.find((rule) => rule.name === run.rule)!;
  const events = eventsOf(view, run.id);
  const eventIds = events.map((event) => event.id);
  const thread = { rule: run.rule, lane: run.lane };
  const answers = rows(view, "cards", { ...thread, answer_event: eventIds });
  const timers = rows(view, "timers", { ...thread, event_id: eventIds });
  const waiting = rows(view, "timers", { ...thread, event_id: null });
  const decided = ["decided", "done"]
    .flatMap((state) => rows(view, "cards", { ...thread, state }, 20, true))
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  const timerView = (timer: Row) => ({ key: timer.key, about: timer.about, at: timer.at });
  return {
    run: run.id,
    token: credential(env, "run", run.id, run.issued),
    attempt: run.attempts + 1,
    rule: { name, cwd, skill, prompt, emits },
    agent: { ...rules.agents[run.agent], id: run.agent },
    session: run.session ?? run.resume,
    askFirst: rules.askFirst,
    context: {
      events: events.map(({ key: id, source, type, subject, summary, detail, link, received_at: receivedAt, hops }) => {
        const sourceName = rules.sources[source]?.name ?? source;
        return { id, source, sourceName, type, subject, summary, detail, link, receivedAt, hops: hops ?? 0 };
      }),
      answers: answers.map(({ id: card, title, options, choice, answer: text, about, by, decided_at: at }) => {
        return { card, title, options: JSON.parse(options), choice, text, about, by, at };
      }),
      timers: timers.filter((timer) => eventIds.includes(timer.event_id)).map(timerView),
      waiting: waiting.sort((a, b) => a.at.localeCompare(b.at)).map(timerView),
      open: openInScope(view, run).map(({ id, title, text, created_at }) => ({
        card: id,
        title,
        text,
        at: created_at,
      })),
      decided: decided
        .filter((card) => !answers.some((answer) => answer.id === card.id))
        .map(({ id, title, choice, answer, options, decided_at }) => {
          return { card: id, title, choice: choice === null ? answer : JSON.parse(options)[choice], at: decided_at };
        }),
    },
  };
}

export function cancels(view: View, worker: string): number[] {
  const stopping = (run: Row) => run.state === "claimed" && run.cancel_at !== null && workerOf(view, run) === worker;
  return rows(view, "runs", { state: "claimed" })
    .filter(stopping)
    .map((run) => run.id);
}

export function unrouted(view: View, limit = 20) {
  return rows(view, "events", { routed: "[]" }, limit, true);
}

export const safeFact = (fact: Fact) => ({ ...fact, changes: fact.changes.filter(({ table }) => table !== "keys") });

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
      if (table === "runs" && row.state === "cancelled" && String(row.summary ?? "").includes("规则已删除")) {
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

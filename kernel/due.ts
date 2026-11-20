// The next moment each thing needs the clock: schedules, reviews, retries, card resends, a worker gone quiet, a lease
// run out. The shell keeps one timer, for the earliest of them, so nothing has to poll.
import { iso, rows, type Row, type View } from "./evolve.ts";
import { agentsOf, configuration, loadOf, workers } from "./query.ts";

export const MINUTE = 60_000;
/** A worker seen this recently is really there, so a run it has stopped mentioning has really gone quiet. */
export const WORKER_FRESH = 2 * MINUTE;
/** How long a claimed run can go unmentioned by its worker before it's in doubt. */
export const RUN_LEASE = 5 * MINUTE;
/** How long work can wait on a worker that doesn't come before the owner hears. */
export const OFFLINE_AFTER = 10 * MINUTE;
/**
 * How often being seen goes in the log. A worker asks every second with work in hand and a fact is a disk sync, so a stamp
 * can be behind the last contact by this much. It has to stay under what reads it: with the 50 seconds between idle polls,
 * under WORKER_FRESH; and under RUN_LEASE - WORKER_FRESH, or a run could look quiet while its worker still looks there.
 */
export const SEEN_EVERY = MINUTE;

/**
 * The card about a worker gone away, and whether it has said all there is to say: it's still open, or the owner closed it
 * after everything now waiting had come in. Anything newer is news, or one closed card would hide it until the worker's
 * back. What is still waiting is asked of the caller, so this reads the card alone.
 */
export function offlineCard(view: View, worker: string, hasNewer: (closedAt: string) => boolean) {
  const seen = view.get("seen", `worker:${worker}`);
  const key = `worker:${worker}:offline:${seen ? seen.seen_at : "never"}`;
  const card = rows(view, "cards", { key }, 1, true)[0];
  const told = card && (card.state === "open" || !hasNewer(card.closed_at));
  return { key, told };
}

/** Whether a ready round of this worker's agents arrived after `at`. An index range, not a walk of the queue. */
export function newerWaiting(view: View, worker: string, now: number, at: string) {
  for (const agent of agentsOf(view, worker)) {
    if (rows(view, "runs", { agent, state: "queued", not_before: { lte: iso(now) }, created_at: { gt: at } }, 1).length)
      return true;
  }
  return false;
}

export function deadlines(view: View, now: number) {
  const due: Record<string, Row> = {};
  const add = (kind: string, key: string, at: number) => {
    due[`${kind}:${key}`] = { kind, key, at };
  };
  const scheduled = (rule: string) =>
    configuration(view).rules.some((known) => known.name === rule && "cron" in known.when);
  for (const schedule of rows(view, "schedules")) {
    if (scheduled(schedule.rule)) add("cron", schedule.rule, Date.parse(schedule.next_at));
  }
  for (const pause of rows(view, "pauses")) {
    if (pause.until !== null) add("pause", pause.name, Date.parse(pause.until));
  }
  for (const limit of rows(view, "limits")) add("limit", limit.agent, Date.parse(limit.until));
  for (const timer of rows(view, "timers", { event_id: null })) add("later", String(timer.id), Date.parse(timer.at));
  // Only a round waiting out its backoff needs a deadline of its own: a ready one goes the moment a worker asks.
  for (const run of rows(view, "runs", { state: "queued", not_before: { gt: iso(now) } })) {
    add("retry", String(run.id), Date.parse(run.not_before));
  }
  for (const delivery of rows(view, "deliveries", { given_up: 0, not_before: { not: null } })) {
    const notBefore = Date.parse(delivery.not_before);
    if (notBefore > now) add("delivery", `${delivery.card_id}:${delivery.channel}`, notBefore);
  }
  for (const worker of workers(view)) {
    const seen = view.get("seen", `worker:${worker}`);
    const { inHand, oldest } = loadOf(view, worker, now);
    if (!inHand.length && !oldest) continue;
    // The sweep acts strictly after each limit, hence the extra millisecond.
    const hasNewer = (closedAt: string) =>
      inHand.some((run) => run.created_at > closedAt) || newerWaiting(view, worker, now, closedAt);
    if (!offlineCard(view, worker, hasNewer).told) {
      add("offline", worker, Math.max(now, Date.parse(seen?.seen_at ?? oldest!.created_at) + OFFLINE_AFTER + 1));
    }
    if (!seen || now - Date.parse(seen.seen_at) > WORKER_FRESH) continue;
    for (const run of inHand) {
      const at = Math.max(now, Date.parse(run.seen_at) + RUN_LEASE + 1);
      if (at <= Date.parse(seen.seen_at) + WORKER_FRESH) add("lease", String(run.id), at);
    }
  }
  return due;
}

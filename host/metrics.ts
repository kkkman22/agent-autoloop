// The numbers a monitor scrapes: plain text, owner only, and nothing anyone wrote. The counts come from the projection,
// the sizes and process numbers from this machine. One line per sample, in a fixed order, so a diff means a real change.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dayStart } from "../kernel/cron.ts";
import { countsOf, ONLINE } from "./state.ts";
import { formatOf } from "./fingerprint.ts";
import { HOME } from "./home.ts";
import { versionName } from "./version.ts";
import { all, environment, one, rules } from "./runtime.ts";

// The version is what the repository says about this checkout (a release tag, or the commit); it lives in no file.
const version = versionName();
/** The states a run can be in, in the order `status` reports them, plus the ones waiting to be tried again. */
const STATES = ["queued", "claimed", "unknown", "done", "nothing", "retrying"];
/** A quote, a backslash or a newline in a rule name must not run the rest of the line into the value. */
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
const bytes = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};
const sum = (rows: { count: number; retrying: number; today: number }[], field: "count" | "retrying" | "today") =>
  rows.reduce((total, row) => total + row[field], 0);

export function metricsText(commit: string, now = Date.now()) {
  // Facts are numbered from 1 without gaps, so the last number is the count, and reading it doesn't walk the whole log.
  const last = Number(one<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM facts")!.seq);
  const facts = { n: last, seq: last };
  const meta = one<{ seq: number; format: string }>("SELECT seq, format FROM projection_meta WHERE id=1");
  const runs = countsOf(all, new Date(dayStart(now, rules.timezone)).toISOString());
  const seen = all<{ kind: string; name: string; seen_at: string }>("SELECT kind, name, seen_at FROM seen");
  const online = (kind: string) =>
    seen.filter((row) => row.kind === kind && now - Date.parse(row.seen_at) <= ONLINE).length;
  const deliveries = one<{ failed: number; given_up: number }>(
    `SELECT SUM(CASE WHEN given_up = 0 AND error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
      SUM(given_up) AS given_up FROM deliveries`,
  )!;

  const lines = [
    `# agent-autoloop ${version}: owner-only numbers, no card or event text and no keys`,
    `hub_build_info{version=${quoted(version)},commit=${quoted(commit)}} 1`,
    `hub_uptime_seconds ${Math.round(process.uptime())}`,
    `hub_process_rss_bytes ${process.memoryUsage().rss}`,
    `hub_facts_total ${facts.n}`,
    `hub_facts_seq ${facts.seq}`,
    `hub_projection_seq ${meta?.seq ?? 0}`,
    `hub_projection_lag ${Math.max(0, facts.seq - (meta?.seq ?? 0))}`,
    `hub_projection_format_matches ${Number(meta?.format === formatOf(environment.secret))}`,
    `hub_db_bytes{file="hub.db"} ${bytes(join(HOME, "hub.db"))}`,
    `hub_db_bytes{file="hub.db-wal"} ${bytes(join(HOME, "hub.db-wal"))}`,
    `hub_db_bytes{file="hub.db-shm"} ${bytes(join(HOME, "hub.db-shm"))}`,
    `hub_cards_open ${all("SELECT id FROM cards WHERE state = 'open'").length}`,
    `hub_runs_done_today ${sum(runs, "today")}`,
    ...STATES.map(
      (state) =>
        `hub_runs{state=${quoted(state)}} ${
          state === "retrying"
            ? sum(runs, "retrying")
            : sum(
                runs.filter((row) => row.state === state),
                "count",
              )
        }`,
    ),
    `hub_workers_online ${online("worker")}`,
    `hub_channels_online ${online("channel")}`,
    `hub_deliveries_failed_total ${deliveries.failed ?? 0}`,
    `hub_deliveries_given_up_total ${deliveries.given_up ?? 0}`,
  ];
  // Rules still in the file and rules that only appear in the log both get a line: history is what it is.
  for (const name of [...new Set([...rules.rules.map((rule) => rule.name), ...runs.map((row) => row.rule)])].sort()) {
    const mine = runs.filter((row) => row.rule === name);
    lines.push(
      ...STATES.map(
        (state) =>
          `hub_runs_by_rule{rule=${quoted(name)},state=${quoted(state)}} ${
            state === "retrying"
              ? mine.reduce((total, row) => total + row.retrying, 0)
              : mine.filter((row) => row.state === state).reduce((total, row) => total + row.count, 0)
          }`,
      ),
    );
    lines.push(
      `hub_run_tokens_total{rule=${quoted(name)}} ${mine.reduce((total, row) => total + row.input + row.output, 0)}`,
    );
    lines.push(`hub_run_cost_total{rule=${quoted(name)}} ${mine.reduce((total, row) => total + row.cost, 0)}`);
  }
  return `${lines.join("\n")}\n`;
}

import type { Fact } from "../kernel/evolve.ts";
import type { Hub } from "../protocol/client.ts";
import type { Usage } from "../protocol/validate.ts";
import { readRuns } from "./runs.ts";

type History = Pick<Hub, "state" | "ruleRuns" | "why">;
export type HistoryRun = {
  id: number;
  rule: string;
  attempts: number;
  claimedAt?: string | null;
  finishedAt?: string | null;
  events?: { type: string }[];
  usage?: Usage | null;
};
const labels = { recheck: "到期复查", answer: "人工回答", mixed: "多种触发", other: "其他触发", unknown: "来源未明" };
type Cause = keyof typeof labels;

async function causeOf(owner: History, run: HistoryRun): Promise<Cause> {
  if (!run.events?.length) return "unknown";
  // The history API shows at most 20 events. A full page may hide a trigger of a different kind.
  if (run.events.length < 20 && run.events.every((e) => e.type !== "timer.due" && e.type !== "card.answered"))
    return "other";

  // Sources can use the same event type names. Only an actual timer or decision proves who woke the run.
  const facts: Fact[] = await owner.why(run.id);
  const links = new Map<string, number>();
  const causes = new Map<number, Cause>();
  for (const fact of facts) {
    for (const { table, key, row } of fact.changes) {
      if (table === "run_events") {
        if (row?.run_id === run.id) links.set(key, row.event_id);
        if (!row) links.delete(key);
      }
      if (table === "events" && row && !causes.has(row.id)) causes.set(row.id, "other");
      if (table === "timers" && row?.event_id != null) causes.set(row.event_id, "recheck");
      if (table === "cards" && row?.answer_event != null) causes.set(row.answer_event, "answer");
    }
  }
  const kinds = new Set([...links.values()].map((id) => causes.get(id) ?? "unknown"));
  if (kinds.size === 1) return [...kinds][0];
  return kinds.size ? "mixed" : "unknown";
}

type Measure = { sum: number; reported: number };
const measure = (): Measure => ({ sum: 0, reported: 0 });
function add(total: Measure, value?: number) {
  if (value === undefined || value === null) return;
  total.sum += value;
  total.reported++;
}

function newGroup(rule: string, cause: Cause) {
  return {
    rule,
    cause,
    rounds: 0,
    withFailures: 0,
    examples: [] as number[],
    input: measure(),
    cached: measure(),
    uncachedInput: measure(),
    output: measure(),
    cost: measure(),
  };
}

export async function wakeupReport(owner: History, rule: string | undefined, limit: number) {
  const groups = new Map<string, ReturnType<typeof newGroup>>();
  let examined = 0;
  let excluded = 0;
  let before: number | undefined;
  let hasMore = false;
  while (examined < limit) {
    const page = await readRuns(owner, rule, before);
    const batch: HistoryRun[] = page.runs.slice(0, limit - examined);
    for (const run of batch) {
      examined++;
      if (!run.finishedAt || (!run.claimedAt && !run.usage && !run.attempts)) {
        excluded++;
        continue;
      }
      const cause = await causeOf(owner, run);
      const key = JSON.stringify([run.rule, cause]);
      const group = groups.get(key) ?? newGroup(run.rule, cause);
      groups.set(key, group);
      group.rounds++;
      if (run.attempts > 0) group.withFailures++;
      if (group.examples.length < 3) group.examples.push(run.id);
      const u = run.usage ?? {};
      add(group.input, u.input);
      add(group.cached, u.cached);
      // Older adapters could report input excluding cache reads.
      if (u.input != null && u.cached != null && u.input >= u.cached) add(group.uncachedInput, u.input - u.cached);
      add(group.output, u.output);
      add(group.cost, u.cost);
    }
    hasMore = batch.length < page.runs.length || page.more != null;
    if (page.more == null || examined >= limit) break;
    before = page.more;
  }
  return { examined, excluded, hasMore, groups: [...groups.values()] };
}

export function wakeupText(report: Awaited<ReturnType<typeof wakeupReport>>) {
  const lines = [
    `查看了 ${report.examined} 条历史，排除未结束或未执行的 ${report.excluded} 条。${report.hasMore ? "还有更早的历史，可增大 --limit。" : ""}`,
  ];
  for (const group of report.groups) {
    const show = (m: Measure) => (m.reported ? `${m.sum}（${m.reported}/${group.rounds} 轮上报）` : "未上报");
    lines.push(
      `${group.rule} · ${labels[group.cause]} · ${group.rounds} 轮，其中有过失败的 ${group.withFailures} 轮`,
      `  输入 ${show(group.input)}，其中缓存读取 ${show(group.cached)}；未缓存输入 ${show(group.uncachedInput)}，输出 ${show(group.output)}，费用 ${show(group.cost)}`,
      `  核对轮次：${group.examples.map((id) => "#" + id).join("、")}`,
    );
    if (group.cause === "recheck" && group.rounds > 1)
      lines.push("  多次到期复查。用 why 核对事项和外部状态是否变化，再决定是否改用脚本探测。");
  }
  return lines.join("\n");
}

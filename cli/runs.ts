// `agent-autoloop runs`: the finished runs before the few `status` shows, so `why` can be given a number. It pages through
// /v1/state on older hubs; newer ones can return one rule's finished runs in one request.
import { HubError, type Hub } from "../protocol/client.ts";
import { finished, runRows, shellWord } from "./status.ts";

type Page = (before?: number) => Promise<any>;

/**
 * Up to `want` finished runs, newest first, older than `before` and of `rule` when given. `more` is where the next list
 * starts, or null when there's nothing older.
 */
export async function findRuns(
  page: Page,
  { rule, before, want = 20 }: { rule?: string; before?: number; want?: number },
) {
  const runs: any[] = [];
  let cursor = before;
  let first: any;
  for (;;) {
    const state = await page(cursor);
    first ??= state;
    // The newest page also carries every run still unsettled, however old; each is read on its own page instead.
    const own = state.runs.filter((run: any) => state.nextBefore === null || run.id >= state.nextBefore);
    const matching = own.filter((run: any) => finished(run) && (rule === undefined || run.rule === rule));
    for (const run of matching) {
      if (runs.length === want) return { state: first, runs, more: runs.at(-1).id as number };
      runs.push(run);
    }
    if (!state.hasMore) return { state: first, runs, more: null };
    if (runs.length === want) return { state: first, runs, more: runs.at(-1).id as number };
    cursor = state.nextBefore;
  }
}

export async function readRuns(owner: Pick<Hub, "state" | "ruleRuns">, rule?: string, before?: number) {
  if (rule) {
    try {
      const page = await owner.ruleRuns(rule, before);
      return { state: page, runs: page.runs, more: page.nextBefore };
    } catch (error) {
      if (!(error instanceof HubError && error.status === 404)) throw error;
    }
  }
  return findRuns(owner.state, { rule, before });
}

export function runsText(
  found: Awaited<ReturnType<typeof findRuns>>,
  { rule, color, columns }: { rule?: string; color: boolean; columns?: number },
) {
  if (!found.runs.length) return rule === undefined ? "还没有做完的轮次。" : `规则「${rule}」没有做完的轮次。`;
  const lines = runRows(found.state, found.runs, { color, columns });
  lines.push("", "细节：agent-autoloop why <第几轮>");
  if (found.more !== null) {
    // The suggestion is for pasting into this machine's shell, so the rule name goes through the same quoting the
    // replay command uses: a rule may be named anything, and a bare `;` or unquoted `$(…)` would run it as a command.
    const named = rule === undefined ? "" : ` ${shellWord(rule, process.platform === "win32")}`;
    lines.push(`更早的：agent-autoloop runs${named} --before ${found.more}`);
  }
  return lines.join("\n");
}

// One delivery run: `node run.ts group/name`, reading its event from AGENT_AUTOLOOP_CONTEXT and printing a receipt.
// The platform comes from AGENT_AUTOLOOP_DELIVERY_HOST (github by default); both speak the same host's words.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIO as createGitlabIO, gitlabApi } from "./gitlab.ts";
import { createIO as createGithubIO } from "./github.ts";
import { deliver, disableAuto, status, type DeliveryIO } from "./delivery.ts";
import { hostFor } from "./host.ts";
import { deliveryReceipt, question, receiptBlock, subjectNumber } from "./input.ts";

const platform = (): "github" | "gitlab" =>
  process.env.AGENT_AUTOLOOP_DELIVERY_HOST === "gitlab" ? "gitlab" : "github";
const hasLabel = (issue: any, name: string) =>
  issue.labels.some((label: any) => (typeof label === "string" ? label : label.name) === name);

/** The issue/MR an event names, in the shapes run() reads: labels as named things, and pull_request as "is a MR". */
async function issueOf(io: DeliveryIO, repo: string, number: number) {
  if (platform() === "github") return io.api(`issues/${number}`);
  const api = gitlabApi(repo);
  try {
    const mr = await api(`merge_requests/${number}`);
    return { ...mr, labels: (mr.labels ?? []).map((label: string) => ({ name: label })), pull_request: true };
  } catch {
    const issue = await api(`issues/${number}`);
    return { ...issue, labels: (issue.labels ?? []).map((label: string) => ({ name: label })) };
  }
}

export async function run(repo: string, context: any, testLocalHealth = false) {
  const number = subjectNumber(repo, context);
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-"));
  const io = platform() === "gitlab" ? createGitlabIO(repo, folder) : createGithubIO(repo, folder);
  try {
    const issue = await issueOf(io, repo, number);
    if (!issue.pull_request) {
      if (issue.state !== "open" && issue.state !== "opened") return "没事可做：没有待处理的问题";
      if (!hasLabel(issue, "ask-owner")) return "没事可做：没有待处理的问题";
      if (context.answers?.length) {
        await hostFor(io, repo).removeLabel(number, "ask-owner");
        return "已记录处理结果";
      }
      return `有一件事需要你处理\n${receiptBlock({ ask: [question(issue)] })}`;
    }
    try {
      const result = await deliver(repo, number, io, testLocalHealth);
      return deliveryReceipt(number, result, hasLabel(issue, "deliver-attended"));
    } catch (error) {
      const change = await hostFor(io, repo).change(number);
      if (change.autoMerge) await disableAuto(number, io, repo);
      await status(io, change.headSha, "delivery", "failure", (error as Error).message, repo);
      throw error;
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [repo, ...args] = process.argv.slice(2);
  const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  run(repo, context, args.includes("--test-local-health"))
    .then((text) => console.log(text))
    .catch((error) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}

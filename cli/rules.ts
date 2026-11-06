// The `rules` commands that only read: validate says what would silently do nothing, explain says what a rule does.
// They parse the rules file exactly like the hub does, but never write it; a broken file is reported, not fixed.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { parseRules, ruleWarnings } from "../protocol/rules.ts";
import { RULES_FILE } from "../host/home.ts";

const fail = (words: string): never => {
  console.error(words);
  process.exit(1);
};

const load = (file: string): Rules => {
  try {
    return parseRules(readFileSync(file, "utf8"), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch (error) {
    return fail((error as Error).message);
  }
};

/** Key names come from the hub's own records; without an install there they are, so that one warning is skipped. */
async function known() {
  const known: Parameters<typeof ruleWarnings>[1] = {
    cwdExists: (dir) => existsSync(dir.startsWith("~/") ? path.join(homedir(), dir.slice(2)) : dir),
  };
  try {
    const { listKeys } = await import("../host/runtime.ts");
    known.keys = listKeys()
      .filter((key) => key.kind === "source")
      .map((key) => key.name);
  } catch {}
  return known;
}

async function validate(file?: string) {
  const rules = load(file ?? RULES_FILE);
  console.log("规则没问题。");
  const warnings = ruleWarnings(rules, await known());
  if (warnings.length) console.log(`警告（不影响生效）：\n${warnings.map((words) => `  ${words}`).join("\n")}`);
}

const TELL = { always: "每次做完都通知", needed: "需要你决定时才问", never: "从不通知" } as const;

function describe(rule: Rule, rules: Rules, indent: string) {
  const agent = rules.agents[rule.to];
  console.log(`${indent}规则「${rule.name}」`);
  if (eventRule(rule)) {
    console.log(
      `${indent}  事件：来源 ${rules.sources[rule.when.source]?.name ?? rule.when.source}（${rule.when.source}），类型 ${rule.when.types.join("、")}`,
    );
  } else {
    console.log(`${indent}  定时：${describeCron(cronOf(rule))}（${rules.timezone}）`);
    const clock = {
      timeZone: rules.timezone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    } as const;
    let at = Date.now();
    const times: string[] = [];
    for (let n = 0; n < 3; n++) {
      const next = nextRun(parseCron(cronOf(rule))!, at, rules.timezone);
      if (next === null) break;
      times.push(new Intl.DateTimeFormat("zh-CN", clock).format(next));
      at = next;
    }
    if (times.length) console.log(`${indent}  接下来：${times.join("、")}`);
  }
  console.log(
    `${indent}  Agent：${agent?.name ?? rule.to}（${rule.to}）· 接单程序 ${agent?.worker} · 权限 ${agent?.access}`,
  );
  console.log(`${indent}  目录：${rule.cwd}`);
  if (rule.skill) console.log(`${indent}  技能：${rule.skill}`);
  if (rule.prompt) console.log(`${indent}  提示词：${rule.prompt}`);
  console.log(
    `${indent}  并发：组 ${rule.group}${(rule.parallel ?? 1) > 1 ? `，最多 ${rule.parallel} 轮并行，不同事项各占一线` : "，一次一轮"}`,
  );
  console.log(`${indent}  通知：${TELL[rule.tell]}`);
}

function explain(args: string[]) {
  const [first, second] = args;
  if (!first) return fail("用法：agent-autoloop rules explain <来源> <事件类型>，或 rules explain <规则名>");
  const rules = load(RULES_FILE);
  if (second !== undefined) {
    const matched = rules.rules.filter(
      (rule) => eventRule(rule) && rule.when.source === first && typeMatches(rule.when.types, second),
    );
    if (!matched.length) return console.log(`没有规则接来源 ${first} 的 ${second}。`);
    console.log(`${matched.length} 条规则接来源 ${first} 的 ${second}：`);
    for (const rule of matched) describe(rule, rules, "  ");
    return;
  }
  const rule = rules.rules.find((rule) => rule.name === first);
  if (!rule) return fail(`没有叫「${first}」的规则。`);
  describe(rule, rules, "");
}

export async function rules(args: string[]) {
  const [action, ...rest] = args;
  if (action === "validate" || action === undefined) return validate(rest[0]);
  if (action === "explain") return explain(rest);
  return fail("用法：agent-autoloop rules validate [文件] | rules explain <来源> <事件类型> | rules explain <规则名>");
}

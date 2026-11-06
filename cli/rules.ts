// The `rules` commands: validate says what would silently do nothing, explain says what a rule does, and the
// write-back commands preview the impact on the running hub, ask, then leave a backup and swap the file in place.
// They parse the rules file exactly like the hub does; a broken file is reported, not fixed.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { hubClient } from "../protocol/client.ts";
import { parseRules, ruleWarnings } from "../protocol/rules.ts";
import { readConfig } from "../host/config.ts";
import { RULES_FILE } from "../host/home.ts";
import { flags } from "./flags.ts";

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

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
type Impact = {
  added: string[];
  removed: string[];
  renamed: { from: string; to: string }[];
  changed: string[];
  cancels: { rule: string; count: number; runs: number[] }[];
  closes: { rule: string; count: number; cards: { id: number; title: string }[] }[];
  claimed: { run: number; rule: string }[];
};

function showImpact(summary: Impact) {
  const moved = [
    ...summary.added.map((name) => `新增「${name}」`),
    ...summary.removed.map((name) => `删除「${name}」`),
    ...summary.renamed.map(({ from, to }) => `「${from}」改名为「${to}」`),
    ...summary.changed.map((name) => `改动「${name}」`),
  ];
  if (moved.length) console.log(`规则变化：${moved.join("，")}`);
  const listing = (items: (string | number)[], count: number) =>
    `（#${items.join("、#")}${count > items.length ? `，共 ${count}` : ""}）`;
  for (const { rule, count, runs } of summary.cancels)
    console.log(`会取消排队轮次：「${rule}」${listing(runs, count)}`);
  for (const { rule, count, cards } of summary.closes)
    console.log(
      `会关闭卡片：「${rule}」${listing(
        cards.map((card) => card.id),
        count,
      )}：${cards.map((card) => card.title).join("、")}`,
    );
  for (const { run, rule } of summary.claimed) console.log(`已领走，照常跑完：#${run}（${rule}）`);
  if (moved.length + summary.cancels.length + summary.closes.length + summary.claimed.length === 0)
    console.log("没有影响。");
}

/** The hub knows what the change would do to the work already in it, and only it can say. The candidate goes over
 * the wire as it sits in the file: the hub parses it there, and a parsed-again copy would carry injected defaults
 * (the schedule source among them) that no rules file may hold. */
async function preview(candidate: unknown) {
  const config = readConfig();
  const owner = config.owner ?? fail("这台电脑上没有本人的密钥（只接活的电脑改不了规则）");
  try {
    return (await hubClient(config.url, owner).rulesPreview(candidate)) as Impact;
  } catch (error) {
    return fail(`预览要中台在跑：${(error as Error).message}`);
  }
}

/** The file as written, and what it means: the raw JSON goes to the hub, the parsed copy answers for the checks. */
function fromFile(file: string) {
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return fail(`${file} 不是 JSON：${(error as Error).message}`);
  }
  load(file); // validation, with the hub's own message
  return raw;
}

/** A confirmation, or the way to skip it: without a terminal there's nobody to ask. */
async function agreed(warning: string, yes: boolean) {
  if (yes) return true;
  if (!process.stdin.isTTY) return fail(`${warning}确认后重来，加上 --yes。`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(`${warning}继续？[y/N] `);
  terminal.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** The old file is kept beside the new one, which is written whole and renamed over the old in one step. */
function writeBack(text: string) {
  const backup = `${RULES_FILE}.${stamp()}.bak`;
  copyFileSync(RULES_FILE, backup);
  writeFileSync(`${RULES_FILE}.tmp`, text, { mode: 0o600 });
  renameSync(`${RULES_FILE}.tmp`, RULES_FILE);
  return backup;
}

async function diff(file?: string) {
  showImpact(await preview(fromFile(file ?? RULES_FILE)));
}

async function change(action: "disable" | "enable" | "remove", name: string | undefined, yes: boolean) {
  if (!name) return fail(`用法：agent-autoloop rules ${action} <规则名>`);
  const raw = fromFile(RULES_FILE) as { rules: (Rule & { disabled?: boolean })[] };
  const rule = raw.rules.find((rule) => rule.name === name);
  if (!rule) return fail(`没有叫「${name}」的规则。`);
  if (action === "disable") rule.disabled = true;
  else if (action === "enable") delete rule.disabled;
  else raw.rules = raw.rules.filter((rule) => rule.name !== name);
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  parseRules(text, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone); // the written file must still parse
  showImpact(await preview(JSON.parse(text)));
  const words = action === "remove" ? "删除规则" : action === "disable" ? "暂停规则" : "恢复规则";
  if (await agreed(`要${words}「${name}」，按上面列的影响执行。`, yes)) {
    const backup = writeBack(text);
    console.log(`${words}了。之前的文件在 ${backup}。`);
  }
}

async function edit(yes: boolean) {
  const original = readFileSync(RULES_FILE, "utf8");
  const copy = `${RULES_FILE}.edit-${process.pid}`;
  writeFileSync(copy, original, { mode: 0o600 });
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const started = spawnSync("/bin/sh", ["-c", `${editor} "$@"`, "editor", copy], { stdio: "inherit" });
  if (started.error || started.status !== 0) return fail("编辑器没有正常退出，规则文件没动。");
  const text = readFileSync(copy, "utf8");
  if (text === original) {
    rmSync(copy);
    return console.log("没有改动。");
  }
  try {
    parseRules(text, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch (error) {
    return fail(`改出来的规则有问题，规则文件没动。编辑的副本还在 ${copy}：\n${(error as Error).message}`);
  }
  showImpact(await preview(JSON.parse(text)));
  if (await agreed("要用编辑后的内容替换规则文件。", yes)) {
    const backup = writeBack(text);
    rmSync(copy);
    console.log(`换好了。之前的文件在 ${backup}。`);
  } else console.log(`没有换。编辑的副本还在 ${copy}。`);
}

export async function rules(args: string[]) {
  const [action, ...rest] = args;
  if (action === "validate" || action === undefined) return validate(rest[0]);
  if (action === "explain") return explain(rest);
  const { named, rest: words } = flags(rest);
  if (action === "diff") return diff(words[0]);
  if (action === "disable" || action === "enable" || action === "remove")
    return change(action, words[0], named.yes !== undefined);
  if (action === "edit") return edit(named.yes !== undefined);
  return fail(
    "用法：agent-autoloop rules validate [文件] | rules explain <来源> <事件类型> | rules explain <规则名>" +
      " | rules diff [文件] | rules disable|enable|remove <规则名> | rules edit",
  );
}

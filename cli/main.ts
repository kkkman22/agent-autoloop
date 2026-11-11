// The command line: what a person, or their Agent, types.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { hubClient } from "../protocol/client.ts";
import { parseRules } from "../protocol/rules.ts";
import { CONFIG_FILE, readConfig, writeConfig, type Config } from "../host/config.ts";
import { HOME, RULES_FILE } from "../host/home.ts";
import { findOnPath, psQuote } from "../host/command.ts";
import { privateDirectory } from "../host/files.ts";
import {
  aboveDesktop,
  installService,
  removeService,
  restartService,
  runningUp,
  serviceLogs,
  serviceRunning,
  startupInstead,
  systemUnit,
  untilAnswering,
} from "../host/service.ts";
import { versionLine } from "../host/version.ts";
import { flags, text, type Flags } from "./flags.ts";
import { printable, printer } from "./plain-text.ts";
import { addPlugin, pluginReport, plugins } from "./plugins.ts";
import { rules } from "./rules.ts";
import { colorFor, render } from "./status.ts";
import { attemptsOf, newFailure, waitingRetry } from "./try.ts";

const ROOT = path.join(import.meta.dirname, "..");
const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-");
const PROGRAM = path.join(ROOT, "bin", "agent-autoloop.ts");

const HELP = `Agent 自动化中台

  agent-autoloop init [--agent claude|codex] [--command '某个命令 {prompt}'] [--port 3350] [--no-service]
                                    在这台电脑上装好：一个人一台电脑就够
  agent-autoloop try                     用你的 Agent 跑一遍完整流程
  agent-autoloop why <第几轮> [--json] [--raw]
                                    查看时间线；--json 输出原始事实，--raw 不过滤文字里的控制字符
  agent-autoloop conformance <地址> --config <测试凭据文件>
                                    在测试中台上检查协议
  agent-autoloop status [--raw|--json]   现在什么情况：谁在线、等你什么、在做什么、做过什么、花了多少
                                     --json 输出 /v1/state 的原始结构，给脚本用
  agent-autoloop runs [规则] [--before <第几轮>] [--json]
                                    列出做完的轮次，可以只看一条规则、往前翻；细节再用 why
  agent-autoloop answer <卡片> [序号] [--text 别的想法]
                                    回答一张卡片；通知不用写序号
  agent-autoloop resolve <卡片> <结果>   这件事不用决定了，写一句结果
  agent-autoloop doctor                  查哪里没配好
  agent-autoloop rules validate [文件]   校验规则文件并给出警告；check 是它的别名
  agent-autoloop rules explain [文件]    按本机 rules.json（或指定草稿）说明生效的规则、Agent、通道和下次定时
  agent-autoloop rules explain <来源> <事件类型>
                                    列出会接这条事件的规则
  agent-autoloop rules explain <规则名>  一条规则的完整说明，定时规则带上接下来 3 次到点
  agent-autoloop rules diff [文件]       候选文件和正在用的规则对比，并列出影响（要中台在跑）
  agent-autoloop rules disable|enable <规则名>
                                    在规则文件里暂停、恢复一条规则；先预览，确认后写回
  agent-autoloop rules remove <规则名>   删掉一条规则；先预览要取消和关闭的东西
  agent-autoloop rules edit             用 $EDITOR 编辑；保存后校验、预览、确认后替换
  agent-autoloop check [文件]            检查规则文件，不碰中台；不写文件就查 rules.json
  agent-autoloop pause <规则> [--reason 原因] [--until 时间]
                                    暂停一条规则：到点不跑、来事件不接，直到恢复；不改规则文件
  agent-autoloop resume <规则>
                                    恢复；错过的时段不补跑
  agent-autoloop run <规则> [--subject 对象] [--reason 说明]
                                    立即运行一轮，照常排队派活
  agent-autoloop emit <类型> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 来源密钥]
                                    发一条事件；--dry-run 只预演会派给谁，不连接中台
  agent-autoloop tell <编号> [--task 定时任务名]
                                    直接告诉你一件事，内容从标准输入读
  agent-autoloop ask --task <定时任务名>
                                    定时任务问你一件事：标准输入传回执那样的 ask；你答了，它的 Agent 在 cwd 接着做
  agent-autoloop stop <第几轮>           停掉一轮
  agent-autoloop key new <source|worker|channel|owner> <名字>
                                    新建一把密钥（只显示这一次）
  agent-autoloop key list                有哪些密钥
  agent-autoloop key remove <种类> <名字>  立即收回一把密钥
  agent-autoloop key rotate [--yes]      换主密钥；旧的卡片链接和轮次凭据立刻失效
  agent-autoloop backup [目录]           备份数据库、主密钥、配置、规则和 secrets.env 到一个空目录；不填就放在 ~/.agent-autoloop/backups
  agent-autoloop restore <目录> [--yes]  停掉中台后，用一次备份换掉现在的数据
  agent-autoloop add <git 地址> [--ref v版本]
                                    安装插件：读清单、核对兼容和签名，记录版本，不自动更新
  agent-autoloop plugins list             装了哪些插件：版本、提交、签名人、是否兼容
  agent-autoloop plugins update <名字> [--check]
                                    换到更新的版本；--check 只看
  agent-autoloop plugins trust <名字> <公钥文件>
                                    登记签名人公钥；以后安装更新都要签名
  agent-autoloop plugins remove <名字>    删掉插件和安装记录
  agent-autoloop mcp [--allow-writes]     用标准输入输出连接 MCP 客户端；默认只读
  agent-autoloop join <中台地址> --worker <名字> --key <密钥> [--no-service]
                                    另一台电脑只接活时用
  agent-autoloop update [版本]           更新到最新，或者换到某个版本（标签）
  agent-autoloop update --check          看看有没有更新，不改任何东西
  agent-autoloop update --rollback       换回上一次更新之前的版本
  agent-autoloop uninstall [--yes]       卸载程序并保留数据；--yes 跳过确认
  agent-autoloop --version               版本和当前提交
  agent-autoloop help                    这份说明
  agent-autoloop up                      启动（平时由系统服务调用）
  agent-autoloop service install|remove  系统服务

配置和数据在 ${HOME}。规则在 ${RULES_FILE}，改了自动生效。`;

const INIT_USAGE = `用法：agent-autoloop init [--agent claude|codex] [--command '某个命令 {prompt}'] [--port 3350] [--no-service]

  --agent      只接这个 Agent：claude 或 codex。不写就接本机装好的全部
  --command    改用别的命令行 Agent；{prompt} 会作为一个独立参数传进去，带空格的路径用引号括起来；
               这台电脑上找不到这个程序就不装
  --port       中台监听的端口，默认 3350
  --no-service 先不装系统服务，之后手动运行 agent-autoloop up`;

const TRY_USAGE = `用法：agent-autoloop try

用本机接好的 Agent 跑一遍完整流程：提问，进程退出等你回复，你拍板，它接着干完。`;

const STATUS_USAGE = `用法：agent-autoloop status [--raw|--json]

现在什么情况：谁在线、等你什么、在做什么、做过什么、花了多少。
  --raw   只输出纯文字，不带颜色和装饰
  --json  输出 /v1/state 的原始结构，给脚本和看板用`;

const RUNS_USAGE = `用法：agent-autoloop runs [规则] [--before <第几轮>] [--json]

列出做完的轮次，新的在前，一次 20 轮：编号、结束时间、怎么样了、规则和结果。
  规则      只看这一条规则的
  --before  从这一轮往前列，接着上一次列到的地方
  --json    输出这些轮次的原始结构和下一页的 before，给脚本用`;

const UPDATE_USAGE = `用法：agent-autoloop update [版本] [--check] [--rollback]

更新到最新，或者换到某个版本（标签）。
  --check     看看有没有更新，不改任何东西
  --rollback  换回上一次更新之前的版本`;

const UNINSTALL_USAGE = `用法：agent-autoloop uninstall [--yes]

卸载程序并保留规则、密钥和记录。
  --yes  跳过确认`;

const RESTORE_USAGE = `用法：agent-autoloop restore <目录> [--yes]

恢复会替换本机的数据库、主密钥、配置、规则和 secrets.env；先停掉中台，--yes 跳过确认。`;

const RULES_USAGE = `用法：agent-autoloop rules validate [文件]
      agent-autoloop rules explain [<来源> <事件类型> | <规则名>]
      agent-autoloop rules diff [文件]
      agent-autoloop rules disable|enable|remove <规则名> [--yes]
      agent-autoloop rules edit [--yes]`;

/** What each command reads besides its own words, and how to use it. */
const TAKES: Record<string, { flags: string[]; usage: string }> = {
  add: { flags: ["ref"], usage: "用法：agent-autoloop add <git 地址> [--ref v版本]" },
  answer: { flags: ["text"], usage: "用法：agent-autoloop answer <卡片> [序号] [--text 别的想法]" },
  ask: {
    flags: ["task"],
    usage: `用法：agent-autoloop ask --task <定时任务名>，问题从标准输入读：
  { "title": "…", "text": "…", "options": ["…", "…"], "recommend": 0, "about": "留给接着做的", "key": "这件事的固定名字" }
rules.json 里这个定时任务要写 cwd；你答了，中台叫醒它的 Agent 在 cwd 照 skill、prompt 接着做。`,
  },
  backup: { flags: [], usage: "用法：agent-autoloop backup [目录]" },
  check: { flags: [], usage: "用法：agent-autoloop check [文件]" },
  conformance: { flags: ["config"], usage: "用法：agent-autoloop conformance <测试中台地址> --config <测试凭据文件>" },
  doctor: { flags: [], usage: "用法：agent-autoloop doctor" },
  emit: {
    flags: ["dry-run", "subject", "summary", "detail", "link", "id", "key"],
    usage:
      "用法：agent-autoloop emit <类型> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 来源密钥]",
  },
  init: { flags: ["agent", "command", "port", "no-service"], usage: INIT_USAGE },
  join: {
    flags: ["worker", "key", "no-service"],
    usage: "用法：agent-autoloop join <中台地址> --worker <名字> --key <密钥> [--no-service]",
  },
  key: {
    flags: ["yes"],
    usage: `用法：agent-autoloop key new <source|worker|channel|owner> <名字>
      agent-autoloop key list
      agent-autoloop key remove <种类> <名字>
      agent-autoloop key rotate [--yes]`,
  },
  mcp: { flags: ["allow-writes"], usage: "用法：agent-autoloop mcp [--allow-writes]" },
  pause: {
    flags: ["reason", "until"],
    usage: "用法：agent-autoloop pause <规则> [--reason 原因] [--until 时间]",
  },
  plugins: {
    flags: ["check"],
    usage: `用法：agent-autoloop plugins list
      agent-autoloop plugins update <名字> [--check]
      agent-autoloop plugins trust <名字> <公钥文件>
      agent-autoloop plugins remove <名字>`,
  },
  // Only its first word is read as anything: the rest is a result in someone's own words, dashes and all.
  resolve: { flags: [], usage: "用法：agent-autoloop resolve <卡片> <结果>" },
  restore: { flags: ["yes"], usage: RESTORE_USAGE },
  resume: { flags: [], usage: "用法：agent-autoloop resume <规则>" },
  rules: { flags: ["yes"], usage: RULES_USAGE },
  runs: { flags: ["before", "json"], usage: RUNS_USAGE },
  run: { flags: ["subject", "reason"], usage: "用法：agent-autoloop run <规则> [--subject 对象] [--reason 说明]" },
  service: { flags: [], usage: "用法：agent-autoloop service install|remove" },
  status: { flags: ["raw", "json"], usage: STATUS_USAGE },
  stop: { flags: [], usage: "用法：agent-autoloop stop <第几轮>" },
  tell: { flags: ["task"], usage: "用法：agent-autoloop tell <编号> [--task 定时任务名]，内容从标准输入读" },
  try: { flags: [], usage: TRY_USAGE },
  uninstall: { flags: ["yes"], usage: UNINSTALL_USAGE },
  up: { flags: [], usage: "用法：agent-autoloop up" },
  update: { flags: ["check", "rollback"], usage: UPDATE_USAGE },
  why: { flags: ["json", "raw"], usage: "用法：agent-autoloop why <第几轮> [--json|--raw]" },
};

const fail = (words: string): never => {
  console.error(words);
  process.exit(1);
};

/**
 * Stops at a flag the command doesn't read. A misspelt --port would otherwise install with the default in silence, and
 * --help would install at all.
 */
function refuseUnknownFlags(args: string[], { flags: known, usage }: { flags: string[]; usage: string }) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  const unknown = Object.keys(flags(args).named).filter((name) => !known.includes(name));
  if (unknown.length) fail(`不认识的参数：${unknown.map((name) => `--${name}`).join("、")}\n\n${usage}`);
}

const client = (key: string, config = readConfig()) => hubClient(config.url, key);
const ownerClient = (config = readConfig()) =>
  client(config.owner ?? fail("这台电脑上没有本人的密钥（只接活的电脑看不了）"), config);

/** The first rules of a new install: its agents and one rule to try the whole loop with. */
function starterRules(agents: Record<string, object>, first: string) {
  return {
    sources: { local: { name: "本机" } },
    agents,
    channels: { desktop: { name: "桌面通知" } },
    rules: [
      {
        name: "试一下",
        when: { source: "local", types: ["try.*"] },
        to: first,
        cwd: path.join(HOME, "try"),
        prompt:
          "这是 agent-autoloop try 的试跑，不要改任何文件，不要做别的事。读资料文件。" +
          "如果 answers 是空的，就问一个问题：title 写“试跑：选一个颜色”，text 写“这是一次试跑，选哪个都行。”，" +
          'options 写 ["蓝色","绿色"]，key 写 try-color，第一行结论写“问了一个问题”。' +
          "如果 answers 不是空的，第一行结论写“你选了某某，试跑通过”，把某某换成 answers 里的 chosen（所选那项的文字），不附回执。",
      },
    ],
    elsewhere: [],
  };
}

/** Shows the user's Agents how to set it up. Only for the install in its usual place, never over their own. */
function linkSkill() {
  if (process.env.AGENT_AUTOLOOP_HOME) return;
  for (const agent of [".claude", ".codex"]) {
    if (!existsSync(path.join(homedir(), agent))) continue;
    const link = path.join(homedir(), agent, "skills", "agent-autoloop");
    if (lstatSync(link, { throwIfNoEntry: false })) continue;
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(ROOT, "skills", "agent-autoloop"), link, process.platform === "win32" ? "junction" : "dir");
  }
}

/** What to type to run this program: its name if that's what a shell finds, otherwise where it is. */
function howToRun() {
  if (process.platform === "win32") {
    const found = findOnPath("agent-autoloop");
    if (found && realpathSync(found) === realpathSync(path.join(ROOT, "bin", "agent-autoloop.cmd")))
      return "agent-autoloop";
    return `& ${psQuote(process.execPath)} ${psQuote(PROGRAM)}`;
  }
  const found = spawnSync("/bin/sh", ["-c", "command -v agent-autoloop"], { encoding: "utf8" }).stdout.trim();
  if (found && realpathSync(found) === realpathSync(PROGRAM)) return "agent-autoloop";
  return /\s/.test(PROGRAM) ? `'${PROGRAM}'` : PROGRAM;
}

/**
 * A command line split the way a shell would: spaces part words, quotes keep one together and are dropped. No escapes, as
 * a Windows path is all backslashes. Null when a quote is left open.
 */
function commandWords(line: string) {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

/** What was asked for on the command line, or whichever of the usual Agents is installed. */
async function agentsToUse(named: Flags, worker: string) {
  const agents: Record<string, { name: string; worker: string; use: string; command?: string[] }> = {};
  const { adapterFor, findProgram } = await import("../worker/agents.ts");
  const command = text(named.command);
  if (command) {
    const words = commandWords(command);
    if (!words?.length) return fail(`--command 里有没配对的引号：${command}`);
    // Found now, or every run of every rule fails later with the install long said to be done.
    const [first] = words;
    const there = /[\\/]/.test(first)
      ? existsSync(path.resolve(first))
      : /^[\w.+@-]+$/.test(first) &&
        (() => {
          try {
            return Boolean(findProgram(first));
          } catch {
            return false;
          }
        })();
    if (!there) return fail(`找不到 ${first}：先装好它，或者在 --command 里写它的完整路径。`);
    agents.agent = { name: "Agent", worker, use: "command", command: words };
    return agents;
  }
  const wanted = text(named.agent);
  const emptyTurn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: "",
    access: "edit",
    contextFile: "",
    folder: "",
  } as const;
  for (const name of ["claude", "codex"]) {
    if (wanted && wanted !== name) continue;
    const adapter = await adapterFor(name);
    try {
      // An adapter finds its program to build the command line, and throws if it's not there.
      adapter.command(emptyTurn);
      agents[name] = { name: name === "claude" ? "Claude Code" : "Codex", worker, use: name };
    } catch {}
  }
  return agents;
}

async function init(args: string[]) {
  const { named, rest } = flags(args);
  // `init -p 4000` would otherwise install on the default port in silence.
  if (rest.length) return fail(`不认识的参数：${rest.join(" ")}\n\n${INIT_USAGE}`);
  if (existsSync(CONFIG_FILE)) return fail(`已经装过了：${CONFIG_FILE}`);
  privateDirectory(HOME);
  mkdirSync(path.join(HOME, "try"), { recursive: true });
  const hostName = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  const worker = hostName.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents = await agentsToUse(named, worker);
  if (!Object.keys(agents).length) {
    return fail(
      "这台电脑上没找到 Claude Code 或 Codex。先装好并登录，" +
        "或者用 --command 指定别的命令行 Agent，比如 --command 'hermes chat -Q -q {prompt}'",
    );
  }
  const port = text(named.port) ?? "3350";
  const url = `http://127.0.0.1:${port}`;
  const ownRules = !existsSync(RULES_FILE);
  if (ownRules) {
    writeFileSync(RULES_FILE, `${JSON.stringify(starterRules(agents, Object.keys(agents)[0]), null, 2)}\n`);
  }
  const { addKey } = await import("../host/runtime.ts");
  const config: Config = {
    url,
    hub: { listen: `127.0.0.1:${port}`, publicUrl: url },
    worker: { name: worker, key: addKey("worker", worker) },
    source: { name: "local", key: addKey("source", "local") },
    owner: addKey("owner", "owner"),
    // A channel only rules.json knows about, or only this file, would do nothing: it's on only if both are ours to write.
    ...(ownRules && { channels: { desktop: { key: addKey("channel", "desktop") } } }),
  };
  writeConfig(config);
  linkSkill();
  if (!named["no-service"]) {
    installService();
    await waitForHub();
  }
  const names = Object.values(agents).map((agent) => agent.name);
  const reach = ownRules ? "  通道：桌面通知\n" : "";
  const run = howToRun();
  const next = named["no-service"]
    ? `先运行 ${run} up 启动中台，再开一个终端运行 ${run} try 跑一遍完整流程。`
    : `运行 ${run} try 跑一遍完整流程。`;
  console.log(`装好了。\n  Agent：${names.join("、")}\n${reach}  规则：${RULES_FILE}\n\n${next}`);
}

async function join(args: string[]) {
  const { named, rest } = flags(args);
  const [url] = rest;
  const name = text(named.worker);
  const key = text(named.key);
  if (!url || !name || !key) return fail(TAKES.join.usage);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return fail(`中台地址要是完整的网址：${url}`);
  }
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && local)) {
    return fail("远程中台要用 https；http 只允许本机回环地址，其他情况请走 SSH 隧道");
  }
  // Joining another hub must not silently replace this machine's existing hub, worker or owner keys.
  if (existsSync(CONFIG_FILE)) {
    return fail(`已经配置过了：${CONFIG_FILE}。为防止覆盖现有设置，请先备份并手动修改配置。`);
  }
  writeConfig({ url, worker: { name, key } });
  if (!named["no-service"]) installService();
  const next = named["no-service"] ? `运行 ${howToRun()} up 开始。` : "";
  console.log(`这台电脑以 ${name} 的身份接活了。${next}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Card = { id: number; kind: string; title: string; text: string; options: string[]; recommend: number | null };

function showCard(card: Card, say: (...words: unknown[]) => void = console.log) {
  say(`\n【${card.kind === "ask" ? "等你决定" : "要你留意"}】#${card.id} ${card.title}`);
  if (card.text) say(card.text);
  if (card.kind !== "ask") return;
  card.options.forEach((option, index) => {
    say(`  ${index + 1}. ${option}${index === card.recommend ? "（推荐）" : ""}`);
  });
}

const howToAnswer = (card: Card) =>
  card.kind === "ask" ? `回答：agent-autoloop answer ${card.id} <序号>` : `处理完了：agent-autoloop answer ${card.id}`;

async function chooseAt(terminal: ReturnType<typeof createInterface>, card: Card) {
  for (;;) {
    const choice = Number(await terminal.question("\n选几？"));
    if (Number.isInteger(choice) && choice >= 1 && choice <= card.options.length) return choice - 1;
    console.log(`输入 1 到 ${card.options.length}。`);
  }
}

async function tryIt() {
  const say = printer();
  const config = readConfig();
  if (!config.source) return fail("这台电脑上没有来源的密钥。");
  const owner = ownerClient(config);
  const stamp = Date.now();
  // A hub that can't be reached is said just below, when the event doesn't go through.
  const before = await owner.state().catch(() => ({ runs: [] }));
  const attempts = attemptsOf(before.runs);
  await client(config.source.key, config)
    .event({ id: `try-${stamp}`, type: "try.start", subject: `#${stamp}` })
    .catch((error) => fail(`连不上中台（${error.message}）：先 agent-autoloop up 或 agent-autoloop service install`));
  const retrying = waitingRetry(before.runs);
  if (retrying) {
    const clock = { timeZone: before.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Date(retrying.notBefore).toLocaleString("zh-CN", clock);
    say(`上一次没跑成（${retrying.error}），${time} 会自动再试，这次的事件会一起处理。`);
  } else say("事件发出去了，Agent 开始干活……");
  let asked: number | null = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const state = await owner.state();
    const failed = newFailure(state.runs, attempts);
    if (failed) return fail(`Agent 没跑成：${failed.error}\n运行 agent-autoloop doctor 看看。`);
    if (asked === null) {
      // An agent asking the same thing again lands on the card already open, so this may be from before: it's the one.
      const card: Card | undefined = state.cards.find(
        (open: Card) => open.kind === "ask" && open.title.startsWith("试跑"),
      );
      if (!card) continue;
      asked = card.id;
      say("\nAgent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。");
      showCard(card, say);
      if (!process.stdin.isTTY) {
        say(`${howToAnswer(card)}\n答完运行 agent-autoloop status，能看到它接着把活干完。`);
        return;
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await chooseAt(terminal, card);
      terminal.close();
      await owner.answer(card.id, { choice });
      say("收到，Agent 接着干……");
      continue;
    }
    const done = state.recentCards.find(
      (card: { id: number; state: string }) => card.id === asked && card.state === "done",
    );
    if (done) {
      say(`它把活干完了：${done.result}\n\n通了。接下来把 ${RULES_FILE} 改成你自己的规则，或者跟你的 Agent 说一句。`);
      return;
    }
  }
  fail("五分钟没等到结果。运行 agent-autoloop doctor 看看。");
}

async function status(named: Flags) {
  const state = await ownerClient().state();
  if (named.json !== undefined) return console.log(JSON.stringify(state, null, 2));
  const text = render(state, { color: colorFor(process.stdout, process.env), columns: process.stdout.columns });
  console.log(named.raw === undefined ? printable(text) : text);
}

async function runs(args: string[]) {
  const { named, rest } = flags(args);
  if (rest.length > 1 || named.before === true) return fail(RUNS_USAGE);
  const before = named.before === undefined ? undefined : runOf(named.before, RUNS_USAGE);
  const owner = ownerClient();
  const { findRuns, runsText } = await import("./runs.ts");
  const found = await findRuns((at) => owner.state(at), { rule: rest[0], before });
  if (named.json !== undefined) return console.log(JSON.stringify({ runs: found.runs, before: found.more }, null, 2));
  const color = colorFor(process.stdout, process.env);
  console.log(runsText(found, { rule: rest[0], color, columns: process.stdout.columns }));
}

async function answer(args: string[]) {
  const { named, rest } = flags(args);
  const card = Number(rest[0]);
  if (!Number.isInteger(card) || card < 1) return fail(TAKES.answer.usage);
  const words = text(named.text);
  const done = await ownerClient().answer(card, {
    ...(rest[1] !== undefined && { choice: Number(rest[1]) - 1 }),
    ...(words && { text: words }),
  });
  console.log(
    !done.changed
      ? "这张卡片已经处理过了，这次没有改动。"
      : done.state === "closed"
        ? "结案了。"
        : "收到，Agent 接着干。",
  );
}

async function resolve(args: string[]) {
  const [id, ...words] = args;
  const card = Number(id);
  if (!Number.isInteger(card) || card < 1 || !words.length) return fail(TAKES.resolve.usage);
  const { changed } = await ownerClient().resolve(card, words.join(" "));
  console.log(changed ? "结案了。" : "这张卡片已经处理过了，这次没有改动。");
}

async function pause(args: string[]) {
  const { named, rest } = flags(args);
  const body = {
    ...(text(named.reason) && { reason: text(named.reason) }),
    ...(text(named.until) && { until: text(named.until) }),
  };
  if (!rest[0]) return fail(TAKES.pause.usage);
  const done = await ownerClient().pause(rest[0], body);
  console.log(done.changed ? `暂停了「${done.rule}」。` : `「${done.rule}」本来就暂停着。`);
}

async function resume(args: string[]) {
  const { rest } = flags(args);
  if (!rest[0]) return fail(TAKES.resume.usage);
  const done = await ownerClient().resume(rest[0]);
  console.log(done.changed ? `恢复了「${done.rule}」。` : `「${done.rule}」本来就没暂停。`);
}

async function runNow(args: string[]) {
  const { named, rest } = flags(args);
  if (!rest[0]) return fail(TAKES.run.usage);
  const body = {
    ...(text(named.subject) && { subject: text(named.subject) }),
    ...(text(named.reason) && { reason: text(named.reason) }),
  };
  const done = await ownerClient().run(rest[0], body);
  console.log(`排上了：第 ${done.run} 轮。`);
}

async function doctor() {
  let bad = 0;
  const say = (ok: boolean, words: string) => {
    console.log(`${ok ? "●" : "○"} ${words}`);
    if (!ok) bad += 1;
  };
  say(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node}`);
  if (!existsSync(CONFIG_FILE)) return say(false, "还没装好：运行 agent-autoloop init");
  const config = readConfig();
  if (config.hub) {
    try {
      const { channels } = checkRulesFile(RULES_FILE);
      say(true, `规则 ${RULES_FILE}`);
      for (const [id, channel] of Object.entries(channels)) {
        // Nobody answers from a desktop notification, and a link goes only to whoever it's sent to.
        if (id !== "desktop" && !channel.links && !channel.answerers) {
          console.log(`○ ${channel.name}没写 answerers：这个通道里谁都能回答卡片。`);
        }
      }
    } catch (error) {
      say(false, (error as Error).message);
    }
  }
  if (serviceRunning()) say(true, "系统服务在跑");
  else if (systemUnit()) say(true, "系统级服务在跑");
  else say(false, "系统服务没在跑：agent-autoloop service install");
  try {
    const health = await (await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    say(health.ok === true, `中台 ${config.url}（${String(health.commit).slice(0, 12)}）`);
  } catch (error) {
    say(false, `连不上中台 ${config.url}：${(error as any).cause?.code ?? (error as Error).message}`);
  }
  if (config.owner) {
    try {
      const state = await ownerClient(config).state();
      for (const agent of state.agents) {
        say(agent.online, `${agent.name}（${agent.worker}）${agent.online ? "在线" : "不在线"}`);
        if (agent.worker === config.worker?.name) {
          const { adapterFor } = await import("../worker/agents.ts");
          const problem = await adapterFor(agent.use).then(
            (adapter) => adapter.check?.(agent.program) ?? null,
            (error) => String(error.message),
          );
          say(!problem, problem ?? `${agent.name} 可以用`);
        }
      }
      for (const channel of state.channels) say(channel.online, `${channel.name}${channel.online ? "在线" : "不在线"}`);
      const manual = path.join(ROOT, "skills", "agent-autoloop", "SKILL.md");
      if (!state.channels.length) {
        console.log(`○ 还没接通道：Agent 问你时不会主动告诉你，要自己运行 agent-autoloop status 看。接法见 ${manual}`);
      } else if (state.channels.length === 1 && state.channels[0].id === "desktop") {
        console.log(
          "○ 只接了桌面通知：Agent 问你时只有这台电脑会弹通知，人不在电脑前、或者电脑没有图形界面就看不到。" +
            `要发到飞书、钉钉这些地方，接法见 ${manual}`,
        );
      }
    } catch (error) {
      say(false, `读不到中台状态：${(error as Error).message}`);
    }
  }
  const { bad: pluginProblems, notes: pluginNotes } = pluginReport();
  for (const words of pluginProblems) say(false, words);
  for (const words of pluginNotes) console.log(`○ ${words}`);
  if (bad) process.exit(1);
}

/** Only reads the file: checking a draft must not open the hub's database or load the draft into it. */
function checkRulesFile(file: string) {
  let json: string;
  try {
    json = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`读不到 ${file}：${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  return parseRules(json, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function check(args: string[]) {
  const file = path.resolve(args[0] ?? RULES_FILE);
  checkRulesFile(file);
  console.log(`规则没问题：${file}`);
}

async function key(args: string[]) {
  const [action, kind, name] = args;
  if (action === "rotate") {
    const { rotateKey } = await import("../host/backup.ts");
    if (args.includes("--yes") || (await confirmed("换主密钥会让所有旧的卡片链接和正在跑的轮次凭据立刻失效。"))) {
      const { kept } = rotateKey();
      console.log(
        [
          "换好了。",
          ...(kept ? [`换之前那把钥匙和当时的数据在 ${kept}。`] : []),
          "旧的卡片链接、以及已经发出去还没交回结果的轮次凭据，现在都失效了。",
          "用 key new 建的密钥不受影响（只存哈希）。",
          "中台是停着的：启动它就会从日志重建视图，慢一点，数据不丢。",
        ].join("\n"),
      );
    }
    return;
  }
  if (action === "remove") {
    if (!kind || !name) return fail("用法：agent-autoloop key remove <种类> <名字>");
    const { changed } = await ownerClient().removeKey(kind, name);
    console.log(changed ? "密钥已失效。" : "没有这把密钥，可能已经删过了。");
    return;
  }
  const { addKey, listKeys } = await import("../host/runtime.ts");
  if (action === "list") {
    for (const row of listKeys()) console.log(`${row.kind} ${row.name} ${row.created_at}`);
    return;
  }
  if (action !== "new" || !["source", "worker", "channel", "owner"].includes(kind) || !name) {
    return fail("用法：agent-autoloop key new <source|worker|channel|owner> <名字>");
  }
  console.log(addKey(kind as "source", name));
}

async function emit(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const type = rest[0] ?? fail(TAKES.emit.usage);
  const event = {
    id: text(named.id) ?? randomUUID(),
    type,
    ...(text(named.subject) && { subject: text(named.subject) }),
    ...(text(named.summary) && { summary: text(named.summary) }),
    ...(text(named.detail) && { detail: text(named.detail) }),
    ...(text(named.link) && { link: text(named.link) }),
  };
  if (named["dry-run"] !== undefined) {
    // The hub tells a source by its key, and only the key's own source is known here.
    if (text(named.key)) return fail("--dry-run 按这台电脑的来源预演，不能和 --key 一起用");
    if (!config.source) return fail("这台电脑上没有来源的密钥：--dry-run 需要知道来源名");
    const { previewEvent } = await import("./explain.ts");
    console.log("预演（按本机 rules.json，不连接中台、不写日志）：");
    for (const line of previewEvent(readFileSync(RULES_FILE, "utf8"), config.source.name, event)) console.log(line);
    return;
  }
  const secret = text(named.key) ?? config.source?.key ?? fail("这台电脑上没有来源的密钥：用 --key");
  const answer = await client(secret, config).event(event);
  const paused = answer.paused?.length ? `暂停中没接：${answer.paused.join("、")}` : "";
  if (answer.routed.length) console.log(`交给了：${answer.routed.join("、")}${paused && `；${paused}`}`);
  else console.log(paused ? `记下了，${paused}。` : "记下了，没有规则接它。");
}

async function rulesCommand(args: string[]) {
  const { rest } = flags(args);
  if (rest[0] !== "explain" || rest.length > 2) return fail(TAKES.rules.usage);
  const file = rest[1] ? path.resolve(rest[1]) : RULES_FILE;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return fail(`读不到 ${file}：${(error as Error).message}`);
  }
  const { explainRules } = await import("./explain.ts");
  for (const line of explainRules(text, Date.now())) console.log(line);
}

async function tell(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const matter = rest[0] ?? fail(TAKES.tell.usage);
  const words = readFileSync(0, "utf8").trim();
  if (!words) return fail("要说的话从标准输入传，不能为空。");
  const task = text(named.task);
  const secret = task ? config.worker?.key : config.source?.key;
  if (!secret) return fail(task ? "这台电脑不是接单程序" : "这台电脑上没有来源的密钥");
  const answer = await client(secret, config).tell({ key: matter, text: words, ...(task && { task }) });
  console.log(answer.duplicate ? "这件事已经说过了，这次没再发。" : "说了。");
}

async function ask(args: string[]) {
  const { named, rest } = flags(args);
  const task = text(named.task);
  if (!task || rest.length) return fail(TAKES.ask.usage);
  let question: unknown;
  try {
    question = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return fail("问题从标准输入传，是一段 JSON：和回执里的 ask 一样");
  }
  const config = readConfig();
  if (!config.worker) return fail("这台电脑不是接单程序");
  const answer = await client(config.worker.key, config).tell({ task, ask: question });
  console.log(answer.duplicate ? "同一件事还在等你回答，这次没再问。" : "问了。");
}

/** A run is named by its number; anything else would reach the hub as /v1/runs/NaN and come back as "没有这个地址". */
function runOf(word: string | undefined, usage: string) {
  const id = Number(word);
  if (word === undefined || !/^[1-9][0-9]*$/.test(word) || !Number.isSafeInteger(id)) return fail(usage);
  return id;
}

async function why(args: string[]) {
  const id = runOf(
    args.find((arg) => !arg.startsWith("--")),
    "用法：agent-autoloop why <第几轮> [--json]",
  );
  const facts = await ownerClient().why(id);
  if (args.includes("--json")) return console.log(JSON.stringify(facts, null, 2));
  const { formatWhy } = await import("./why.ts");
  console.log(formatWhy(id, facts, args.includes("--raw")));
}

async function checkConformance(args: string[]) {
  const { named, rest } = flags(args);
  const file = text(named.config) ?? process.env.AGENT_AUTOLOOP_CONFORMANCE;
  if (!rest[0] || !file) return fail(TAKES.conformance.usage);
  const { conformance } = await import("../protocol/conformance.ts");
  console.log(JSON.stringify(await conformance(rest[0], JSON.parse(readFileSync(file, "utf8"))), null, 2));
}

async function stop(args: string[]) {
  const id = runOf(args[0], "用法：agent-autoloop stop <第几轮>");
  await ownerClient().cancel(id);
  console.log("通知它停了。");
}

/** A command run right after starting the service would find no hub yet: this machine's is waited for, if it has one. */
async function waitForHub() {
  // An update runs on machines that only take work too, where there is no config and nothing to wait for.
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig();
  } catch {
    return;
  }
  if (!config.hub) return;
  const answering = await untilAnswering(config.url);
  if (answering === false) {
    const log = serviceLogs();
    const last = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").slice(-5).join("\n") : "";
    console.error(`系统服务起了，但中台 20 秒内没有应答。看看日志：${log}${last ? `\n\n${last}` : ""}`);
  }
  // A login task asks for the user's limited token, and the built-in Administrator gets the full one all the same.
  const hub = answering && process.platform === "win32" ? runningUp() : null;
  if (hub !== null && aboveDesktop(hub)) {
    removeService();
    fail(
      "登录任务拉起的中台拿到了比你的桌面高的完整管理员权限，它派的每个 Agent 也会带着，所以没有装这个任务" +
        `（Windows 自带的 Administrator 账号会这样）。${startupInstead()}`,
    );
  }
}

/** fetch says only "fetch failed" when no hub answers; which hub, why and what to do are what a person can act on. */
function plainly(error: any): string {
  if (!(error instanceof TypeError && error.message === "fetch failed")) return error?.message ?? String(error);
  let url = "";
  try {
    url = readConfig().url;
  } catch {}
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message;
  return (
    `连不上中台 ${url}${why ? `（${why}）` : ""}：中台没在运行，或者刚启动还没好。` +
    "在中台那台电脑上运行 agent-autoloop service install 启动它；刚装好、刚更新的等几秒再试。"
  );
}

async function service(args: string[]) {
  if (args[0] === "install") {
    // Installing over kept data comes here and not to init, and uninstalling took the links away.
    linkSkill();
    installService();
    return waitForHub();
  }
  if (args[0] === "remove") return removeService();
  fail(TAKES.service.usage);
}

async function update(args: string[]) {
  const { named, rest } = flags(args);
  const { checkForUpdate, rollBack, updateTo } = await import("./update.ts");
  if (named.check !== undefined) {
    const found = checkForUpdate();
    const now = found.current ?? found.commit.slice(0, 12);
    if (!found.behind) return console.log(`已经是最新的（${now}）。`);
    const newest = found.newest ? `，最新的版本是 ${found.newest}` : "";
    return console.log(
      `现在是 ${now}，落后 ${found.behind} 个提交${newest}。\n` +
        "运行 agent-autoloop update 更新到最新，或者 agent-autoloop update <版本> 换到某个版本。",
    );
  }
  const moved = named.rollback !== undefined ? rollBack() : updateTo(rest[0]);
  if (moved.before === moved.after) return console.log("已经是这个版本了。");
  const told = restartService();
  if (told === undefined) await waitForHub();
  console.log(
    `更新好了：${moved.before.slice(0, 12)} → ${moved.after.slice(0, 12)}。\n` +
      `要换回去：agent-autoloop update --rollback${told ? `\n${told}` : ""}`,
  );
}

/** A confirmation, or the way to skip it: without a terminal there's nobody to ask. */
async function confirmed(warning: string) {
  if (!process.stdin.isTTY) return fail(`${warning}确认后重来，加上 --yes。`);
  return /^y(es)?$/i.test((await askAtTerminal(`${warning}继续？[y/N] `)).trim());
}

async function backup(args: string[]) {
  const [target] = flags(args).rest;
  const { backupTo } = await import("../host/backup.ts");
  const { dir, manifest } = backupTo(target ?? path.join(HOME, "backups", `backup-${stampNow()}`));
  console.log(
    `备份好了：${dir}\n  ${manifest.facts} 条事实，` +
      `${Object.keys(manifest.files).join("、")} 和清单都在里面，只有你能读。\n` +
      `  恢复要用它换掉现在的数据：agent-autoloop restore ${dir} --yes（先停掉中台）。`,
  );
}

async function restore(args: string[]) {
  const { named, rest } = flags(args);
  const dir = rest[0] ?? fail("用法：agent-autoloop restore <备份目录> [--yes]");
  const { restoreFrom } = await import("../host/backup.ts");
  const replace =
    named.yes !== undefined || (await confirmed("恢复会用这份备份换掉现在的数据，旧的文件先挪到 replaced-… 里。"));
  if (!replace) return;
  const done = restoreFrom(dir, { replace });
  console.log(
    [
      `恢复好了：${done.facts} 条事实。`,
      ...(done.replaced ? [`换下来的东西在 ${done.replaced}，确认没问题再删。`] : []),
      ...(done.keyChanged ? ["这份备份用的是另一把主密钥：链接和轮次凭据都跟着换成了它的。"] : []),
      ...(done.rebuilt ? ["备份是别的版本做的，下次启动会从日志重建视图，慢一点，数据不丢。"] : []),
      "中台还停着，确认没问题再启动。",
    ].join("\n"),
  );
}

async function askAtTerminal(question: string) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(question);
  terminal.close();
  return answer;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  mcp: async () =>
    (await import("./mcp.ts")).mcp(
      flags(args).named["allow-writes"] !== undefined || process.env.AGENT_AUTOLOOP_MCP_ALLOW_WRITES === "1",
    ),
  add: () => addPlugin(args),
  plugins: () => plugins(args),
  init: () => init(args),
  join: () => join(args),
  up: async () => (await import("../host/up.ts")).up(),
  try: () => tryIt(),
  status: () => status(flags(args).named),
  why: () => why(args),
  runs: () => runs(args),
  conformance: () => checkConformance(args),
  answer: () => answer(args),
  resolve: () => resolve(args),
  doctor,
  check: () => check(args),
  // With a bare `explain`, or one naming a draft file, it is the whole-file overview; other shapes go to the fuller rules command.
  rules: () =>
    args[0] === "explain" && (args.length === 1 || (args.length === 2 && existsSync(path.resolve(args[1]))))
      ? rulesCommand(args)
      : rules(args),
  pause: () => pause(args),
  resume: () => resume(args),
  run: () => runNow(args),
  key: () => key(args),
  emit: () => emit(args),
  tell: () => tell(args),
  ask: () => ask(args),
  stop: () => stop(args),
  backup: () => backup(args),
  restore: () => restore(args),
  update: () => update(args),
  uninstall: async () => {
    const { uninstall } = await import("./uninstall.ts");
    await uninstall(flags(args).named.yes !== undefined, process.stdin.isTTY ? askAtTerminal : null);
  },
  service: () => service(args),
  help: () => console.log(HELP),
  "--help": () => console.log(HELP),
  "-h": () => console.log(HELP),
  "--version": () => console.log(versionLine()),
};
if (!command || !commands[command]) {
  console.log(HELP);
  if (command) process.exit(1);
} else {
  if (TAKES[command]) refuseUnknownFlags(command === "resolve" ? args.slice(0, 1) : args, TAKES[command]);
  Promise.resolve()
    .then(commands[command])
    .catch((error) => fail(plainly(error)));
}

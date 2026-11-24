// Codex: the user's own, installed and signed in by them. A run is a `codex exec` in the background; its thread is kept
// on disk, so a retry or an answer can go on in it, and the link opens it in the app.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { commandLine, powershell, psQuote } from "../../host/command.ts";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";

const SANDBOX = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };

/** The Codex the desktop app installs, for those without one of their own. */
export function inTheApp() {
  const mac = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  // The Windows installer puts codex.exe in %LOCALAPPDATA%\OpenAI\Codex\bin\<id>; an update adds a new <id> beside the
  // old one and deletes the old one, leaving PATH naming the folder it deleted. So read that folder for the newest
  // codex.exe rather than one path an update rewrites: on 2026-11-20 and 2026-11-21 both morning rules failed with
  // 找不到 codex while the program sat in the folder beside the one PATH named.
  const local = process.env.LOCALAPPDATA;
  const root = local ? path.join(local, "OpenAI", "Codex", "bin") : null;
  if (!root) return mac;
  // An update is emptying these folders while this runs, so each is read on its own and one that has gone is left out:
  // a throw here reaches the round as whichever path vanished rather than as 找不到 codex.
  const folders = (() => {
    try {
      return readdirSync(root, { withFileTypes: true });
    } catch {
      // No Codex desktop install, or a bin this account can't read as a folder.
      return [];
    }
  })();
  const found: { file: string; at: number }[] = [];
  for (const entry of folders) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "codex.exe");
    try {
      found.push({ file, at: statSync(file).mtimeMs });
    } catch {
      // A folder holding another of the app's programs, or one this update is still emptying.
    }
  }
  return [...found.sort((a, b) => b.at - a.at).map((codex) => codex.file), ...mac];
}

export default {
  command: (turn) => {
    // The elevated Windows sandbox runs as CodexSandboxUsers. Share only the supplied data, never the run token or key.
    if (process.platform === "win32" && turn.contextFile)
      powershell(`
      try { $sid = ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier]) }
      catch [Security.Principal.IdentityNotMappedException] { return }
      $file = ${psQuote(turn.contextFile)}
      $acl = [IO.File]::GetAccessControl($file)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'Read', 'Allow'))
      [IO.File]::SetAccessControl($file, $acl)
    `);
    return [
      turn.program ?? findProgram("codex", inTheApp),
      "exec",
      ...(turn.resume ? ["resume"] : []),
      "--json",
      "--skip-git-repo-check",
      ...(turn.model ? ["-m", turn.model] : []),
      ...(turn.effort ? ["-c", `model_reasoning_effort="${turn.effort}"`] : []),
      // Unset, a run takes the tier in ~/.codex/config.toml, a file the Codex app shares: "priority" is its Fast.
      ...(turn.tier ? ["-c", `service_tier="${turn.tier}"`] : []),
      // As config, because `codex exec resume` takes no -s.
      "-c",
      `sandbox_mode="${SANDBOX[turn.access]}"`,
      "-c",
      'approval_policy="never"',
      ...(turn.resume ? [turn.resume] : []),
      "本轮通过后台 codex exec 运行，不要假定桌面应用的浏览器连接已带到本轮。" +
        "网页操作使用本轮实际可用的浏览器工具，或使用规则或 Skill 中已明确配置的浏览器入口。" +
        "沿用该入口的会话，只交网页步骤，业务处理和中台回执仍由本轮负责；没有可用入口或需要本人恢复连接时，按待你处理的约定交回。\n\n" +
        turn.prompt,
    ];
  },
  read(stdout, code, stderr) {
    const seen: {
      text?: string;
      session?: string;
      sessionUsage?: object;
      error?: string;
      finished?: boolean;
      started?: boolean;
      completed?: boolean;
    } = {};
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // A login shell's profile prints here too, and `null` is valid JSON.
      if (!event) continue;
      if (event.type === "thread.started") seen.session = event.thread_id;
      else if (event.type === "turn.started") seen.started = true;
      else if (event.type === "item.completed" && event.item?.type === "agent_message") seen.text = event.item.text;
      else if (event.type === "turn.completed") {
        seen.completed = seen.finished = true;
        // A reconnect is announced as an error event and then got over — it fell back to another transport and carried
        // on — so it isn't how the turn ended. A finished run was redone twelve times over one of these.
        delete seen.error;
        const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0 } = event.usage ?? {};
        seen.sessionUsage = { input: input_tokens, output: output_tokens, cached: cached_input_tokens };
      } else if (event.type === "turn.failed") {
        seen.finished = true;
        seen.error = event.error?.message || "Codex 没跑完这一轮";
      } else if (event.type === "error") seen.error = event.message;
    }
    const { completed, ...reading } = seen;
    // Only a finished turn's last message is its answer; before that it's only as far as it had got.
    if (!completed) delete reading.text;
    if (code !== null && !completed && !reading.error) reading.error = tail(stderr) || "Codex 没有完成并留下实际结果";
    if (completed && !reading.text?.trim()) reading.error = "Codex 没有完成并留下实际结果";
    return reading;
  },
  link: (session) => `codex://threads/${session}`,
  check(program) {
    try {
      execFileSync(...commandLine([program ?? findProgram("codex", inTheApp), "login", "status"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return `Codex 没有登录或用不了：运行 codex login（${(error as Error).message.split("\n")[0]}）`;
    }
  },
} satisfies Adapter;

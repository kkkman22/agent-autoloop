// The Ship step's question, as a GitHub Action: does this commit need releasing, and has main already moved past it?
// Runs from a copy in the project, so it imports nothing beyond this folder's project.ts.
import { appendFileSync, readFileSync } from "node:fs";
import { git, liveRelease, readMainSettings, releaseRequired, type Live, type Settings } from "./project.ts";

export function decideShip(
  target: string,
  main: string,
  live: Live | null,
  required: (base: string, head: string) => boolean,
) {
  return { release: !live || required(live.sha, target), superseded: main !== target && required(target, main) };
}

/** Where this push began: the main it started from, when the platform says. An input beats the event file. */
function beforePush(): string | null {
  if (/^[a-f0-9]{40}$/.test(process.env.INPUT_BEFORE ?? "")) return process.env.INPUT_BEFORE!;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
    return /^[a-f0-9]{40}$/.test(String(event.before)) ? String(event.before) : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const root = process.cwd();
  const target = process.env.INPUT_TARGET || process.env.GITHUB_SHA;
  if (!target || !/^[a-f0-9]{40}$/.test(target)) throw new Error("发布目标要是完整提交编号");
  git(root, "fetch", "origin", "main");
  const main = git(root, "rev-parse", "origin/main");
  // The settings that judge this release are main's from before the push that landed the target: one push can carry the
  // merge and later commits, and the merge itself could have loosened them. Where the push began is the last main none
  // of it had touched; without that, the commit before the tip is the guess that dates furthest back.
  const before = (() => {
    try {
      return readMainSettings(root, process.env.INPUT_TEST_LOCAL_HEALTH === "true", beforePush() ?? `${target}^`);
    } catch {
      return null;
    }
  })();
  let decision: { release: boolean; superseded: boolean };
  if (before) {
    const config: Settings = before;
    const live = await liveRelease(config);
    decision = decideShip(target, main, live, (base, head) => releaseRequired(root, base, head, config.internal));
  } else {
    // Settings nobody can read are not a reason to release on trust: that release waits for a person.
    decision = { release: true, superseded: true };
  }
  const output = Object.entries(decision)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}

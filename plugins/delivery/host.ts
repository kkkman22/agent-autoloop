// What the delivery asks of a hosting platform, said once in the platform's own words instead of a REST dialect:
// read a change back, mark a commit, read checks and their definition, merge behind a head commit, close auto-merge.
// The business logic (delivery.ts) only speaks this; each platform file translates it to and from its REST shapes,
// so the same scenarios hold on any host and the existing GitHub tests keep exercising the GitHub translation.
import { githubHost } from "./github.ts";
import type { DeliveryIO } from "./delivery.ts";
import type { Settings } from "./project.ts";

/** One pull/merge request, read back with the fields the delivery re-checks after every step. */
export type Change = {
  number: number;
  state: string;
  merged: boolean;
  /** The labels on the change right now. */
  labels: Set<string>;
  /** The commit the change wants merged, and the branch it targets. */
  headSha: string;
  baseRef: string;
  /** The repository the head branch lives in: a different name means a fork. */
  headRepo: string | null;
  /** Whether the platform is set to merge the change automatically once its checks pass. */
  autoMerge: boolean;
  draft: boolean;
  author: string;
  mergeCommit: string | null;
};

export type DeliveryHost = {
  /** The change as the platform sees it right now; every re-read after a mutation goes through here. */
  change(number: number): Promise<Change>;
  /** Marks a commit with a context, state and a short line of words. */
  status(head: string, context: string, state: string, description: string): Promise<void>;
  /** Removes one label; a missing label is the platform's own error, which the caller verifies against a re-read. */
  removeLabel(number: number, label: string): Promise<void>;
  /** Where the main branch points right now. */
  mainRef(): Promise<string>;
  /** A file's decoded text at a ref, or null when nothing is there. */
  fileText(ref: string, path: string): Promise<string | null>;
  /** The id of the check's definition file at a ref, or null: two equal ids mean two equal definitions. */
  checkDefinition(config: Settings, ref: string): Promise<string | null>;
  /** Pulls main into a change whose head is still where the caller last saw it. */
  syncMain(number: number, expectedHead: string): Promise<void>;
  /** A draft becomes a normal change, ready to be merged. */
  ready(number: number): Promise<void>;
  /** The state of the change's full check: the workflow run and its required job. */
  checks(config: Settings, head: string): Promise<"passed" | "waiting" | "failed">;
  /** The Ship runs on main, newest first: which commit they built and whether they succeeded. */
  shipRuns(config: Settings): Promise<{ sha: string; ok: boolean }[]>;
};

/** Which platform an io object speaks; everything already wired to the GitHub shapes stays on GitHub. */
export function hostFor(io: DeliveryIO, repo: string): DeliveryHost {
  if (io.host === "gitlab") {
    // Added with the GitLab translation; until then, a mislabelled io is refused rather than misread.
    throw new Error(`GitLab 交付还没有接线（repo：${repo}）`);
  }
  return githubHost(repo, io);
}

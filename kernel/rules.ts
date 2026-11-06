// What the kernel reads in rules: their shape and which events a rule takes. The rules file is checked before it gets
// here, in protocol/rules.ts.
export type Access = "read" | "edit" | "full";
export type Severity = "low" | "normal" | "urgent";
export type Source = { name: string; adapter?: string };
type AgentOptions = { model?: string; effort?: string; command?: string[]; timeout?: number };
export type Agent = AgentOptions & { name: string; worker: string; use: string; access: Access };
export type Channel = { name: string; answerers?: string[]; links?: boolean; quiet?: { from: string; to: string } };
export type Tell = "always" | "needed" | "never";
type EventFilter = { source: string; types: string[] };
type When = EventFilter | { cron: string };
type RuleOptions = {
  skill?: string;
  prompt?: string;
  parallel?: number;
  emits?: EventFilter;
  disabled?: boolean;
  /** The cards this rule makes go to these channels only; without it, to every channel there is. */
  channels?: string[];
  severity?: Severity;
};
/** Without parallel a rule's group runs one at a time; with it, each subject is its own thread, that many at once. */
export type Rule = RuleOptions & { name: string; when: When; to: string; cwd: string; group: string; tell: Tell };
/** A scheduled task that runs elsewhere (say, in the Claude app): the hub neither starts nor records it. */
export type Elsewhere = { name: string; source: string; to: string; cron: string; where: string };
type Registered = { sources: Record<string, Source>; agents: Record<string, Agent>; channels: Record<string, Channel> };
/** Where the cards that belong to no rule go; without channels, to every channel there is. */
type Notices = { channels?: string[] };
export type Rules = Registered & {
  timezone: string;
  askFirst: string[];
  rules: Rule[];
  elsewhere: Elsewhere[];
  notices: Notices;
};

/** The source of what the clock makes happen. */
export const SCHEDULE = "schedule";

function typeMatch(pattern: string, type: string) {
  return pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
}
export const typeMatches = (patterns: string[], type: string) => patterns.some((pattern) => typeMatch(pattern, type));
export const eventRule = (rule: Rule): rule is Rule & { when: EventFilter } => "source" in rule.when;
export const cronOf = (rule: Rule) => (rule.when as { cron: string }).cron;

/** Whether `now` sits in this window, read in the rules' zone. A window may cross midnight; the caller passes the
 * clock, so the kernel never reads one. Outside quiet hours a channel takes every card; inside, only urgent ones. */
export function inQuietHours(quiet: Channel["quiet"], now: number, zone: string) {
  if (!quiet) return false;
  const minuteOf = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const at = Number(parts.hour) * 60 + Number(parts.minute);
  const from = minuteOf(quiet.from);
  const to = minuteOf(quiet.to);
  return from < to ? at >= from && at < to : at >= from || at < to;
}

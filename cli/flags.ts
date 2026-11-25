// What the command line was given: `--name value` pairs, `--name=value`, bare `--name` flags, and the rest in order.
// A bare boolean flag never swallows the word after it: `--yes run` would otherwise install instead of confirming.
export type Flags = Record<string, string | true>;
export const BOOLEAN_FLAGS = new Set(["dry-run", "json", "no-service", "yes"]);

export function flags(args: string[]) {
  const named: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const eq = args[i].indexOf("=", 2);
    if (eq !== -1) {
      named[args[i].slice(2, eq)] = args[i].slice(eq + 1);
      continue;
    }
    const name = args[i].slice(2);
    if (BOOLEAN_FLAGS.has(name)) named[name] = true;
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}
export const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);

// What the command line was given: `--name value` pairs, bare `--name` flags, and the rest in order.
export type Flags = Record<string, string | true>;
export function flags(args: string[]) {
  const named: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}
export const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);

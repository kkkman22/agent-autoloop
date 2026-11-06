// Whether a plugin's declared engine fits this build: only ">=a.b.c" and "<a.b.c", alone or space-separated, which is
// all a plugin needs to say "works from here, breaks there" without a version solver.
const BOUND = /^(>=|<)(\d+)\.(\d+)\.(\d+)$/;

export function validRange(range: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((bound) => BOUND.test(bound));
}

function compare(version: string, limit: number[]): number {
  const numbers = version.split(".").map((part) => Number(part));
  for (const [index, value] of limit.entries()) {
    const mine = numbers[index] ?? 0;
    if (mine !== value) return mine < value ? -1 : 1;
  }
  return 0;
}

export function satisfiesEngine(version: string, range: string | undefined): boolean {
  if (!range) return true;
  return range
    .trim()
    .split(/\s+/)
    .every((bound) => {
      const match = BOUND.exec(bound);
      if (!match) return false;
      const operator = match[1] as ">=" | "<";
      const compared = compare(version, match.slice(2).map(Number));
      return operator === ">=" ? compared >= 0 : compared < 0;
    });
}

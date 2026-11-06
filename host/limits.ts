// How much one caller may ask of this hub at once and per minute. Only in memory: a limit is about this process staying
// up for everyone, not about what happened, so none of it reaches the fact log.
export type Limits = { perMinute: number; burst: number; inFlight: number; waiting: number };

/** Generous for one person's hub: a channel holds a long poll and answers beside it; a burst of webhooks fits. */
export const DEFAULT_LIMITS: Limits = { perMinute: 600, burst: 120, inFlight: 32, waiting: 8 };

/** Requests that are meant to stay open until something happens. */
const WAITING = new Set(["/v1/work", "/v1/cards/next", "/v1/stream"]);
/** Past this many callers, the ones with nothing in flight and a full allowance are forgotten. */
const REMEMBERED = 10_000;

export function limitsFrom(given: unknown): Limits {
  if (given === undefined) return { ...DEFAULT_LIMITS };
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new Error("hub.limits 要是一个对象");
  for (const [name, value] of Object.entries(given)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      throw new Error(`hub.limits 里没有 ${name}，能写的是 ${Object.keys(DEFAULT_LIMITS).join("、")}`);
    }
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`hub.limits.${name} 要是正整数`);
  }
  return { ...DEFAULT_LIMITS, ...(given as Partial<Limits>) };
}

type Caller = { tokens: number; at: number; inFlight: number; waiting: number; saidAt: number };
export type Refusal = { reason: string; retryAfter: number };

export function createLimiter(limits: Limits, log: (line: string) => void, now = Date.now) {
  const callers = new Map<string, Caller>();
  const perMs = limits.perMinute / 60_000;
  const refill = (caller: Caller, moment: number) => {
    caller.tokens = Math.min(limits.burst, caller.tokens + (moment - caller.at) * perMs);
    caller.at = moment;
  };
  const forgetIdle = (moment: number) => {
    if (callers.size < REMEMBERED) return;
    for (const [who, caller] of callers) {
      refill(caller, moment);
      if (!caller.inFlight && caller.tokens >= limits.burst) callers.delete(who);
    }
  };

  /** Either how to give the place back once the answer is over, or why not now and when to come back. */
  return function admit(who: string, path: string): { release(): void } | Refusal {
    const moment = now();
    forgetIdle(moment);
    let caller = callers.get(who);
    if (!caller) {
      caller = { tokens: limits.burst, at: moment, inFlight: 0, waiting: 0, saidAt: -Infinity };
      callers.set(who, caller);
    }
    refill(caller, moment);
    const waits = WAITING.has(path);
    const refusal: Refusal | null =
      caller.inFlight >= limits.inFlight
        ? { reason: `同时最多 ${limits.inFlight} 个请求`, retryAfter: 1 }
        : waits && caller.waiting >= limits.waiting
          ? { reason: `同时最多 ${limits.waiting} 个长轮询`, retryAfter: 5 }
          : caller.tokens < 1
            ? { reason: `每分钟最多 ${limits.perMinute} 次`, retryAfter: Math.ceil((1 - caller.tokens) / perMs / 1000) }
            : null;
    if (refusal) {
      if (moment - caller.saidAt >= 60_000) {
        caller.saidAt = moment;
        log(`limited ${who}: ${refusal.reason}`);
      }
      return refusal;
    }
    caller.tokens -= 1;
    caller.inFlight += 1;
    if (waits) caller.waiting += 1;
    const held = caller;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        held.inFlight -= 1;
        if (waits) held.waiting -= 1;
      },
    };
  };
}

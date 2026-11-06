// Failure modes: a field /v1/state has today getting renamed or dropped tomorrow, silently breaking every client the
// reference console stands for; a new field being treated as a breaking change, so the schema can't grow; the schema
// describing a shape the hub no longer answers with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";
setup("state-schema");
const hub = await import("../host/runtime.ts");
const schema = (await import("../protocol/schema.json", { with: { type: "json" } })).default;

// A deliberately small JSON Schema checker: the keywords this repo's schemas use, nothing more. External clients run
// real validators; this one only has to catch drift between the schema and what the hub actually answers.
function check(data: unknown, def: any, root: any = schema, where = "state"): string[] {
  const problems: string[] = [];
  const fail = (why: string) => problems.push(`${where}: ${why}`);
  if (def.$ref) return check(data, root.$defs[def.$ref.split("/").at(-1)], root, where);
  const wanted: string[] = Array.isArray(def.type) ? def.type : def.type ? [def.type] : [];
  if (def.enum && !def.enum.includes(data)) fail(`${JSON.stringify(data)} 不在 ${JSON.stringify(def.enum)}`);
  if (wanted.length) {
    const is = (name: string) =>
      name === "integer"
        ? Number.isInteger(data)
        : name === "number"
          ? typeof data === "number"
          : name === "null"
            ? data === null
            : name === "array"
              ? Array.isArray(data)
              : name === "object"
                ? typeof data === "object" && data !== null && !Array.isArray(data)
                : typeof data === name;
    if (!wanted.some(is))
      fail(
        `类型是 ${Array.isArray(data) ? "array" : data === null ? "null" : typeof data}，要 ${JSON.stringify(def.type)}`,
      );
  }
  if (wanted.includes("object") && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const name of def.required ?? []) if (!(name in record)) fail(`缺 ${name}`);
    for (const [name, spec] of Object.entries<any>(def.properties ?? {}))
      if (name in record) problems.push(...check(record[name], spec, root, `${where}.${name}`));
  }
  if (wanted.includes("array") && Array.isArray(data) && def.items) {
    for (const [index, item] of data.entries()) problems.push(...check(item, def.items, root, `${where}[${index}]`));
  }
  return problems;
}

const origin = structuredClone(hub.getView().get("config", "rules")!.value);
const start = at(0);
// A round of everything the state pages can show: a question asked and answered, a finished follow-up, a delivery
// that fails, a schedule ticking, an unrouted event and a page of history.
hub.execute("rules", [structuredClone(origin)], start);
hub.ingest("app", { id: "ss:1", type: "feedback.new", subject: "#1" }, at(1));
const job = hub.claimNext("w1", "c1", at(1))!;
hub.finish(
  job.run,
  job.token,
  { outcome: "done", ask: [{ title: "问 1", text: "选", options: ["甲", "乙"], key: "k1" }] },
  at(2),
);
const card = hub.one<{ id: number }>("SELECT id FROM cards WHERE state = 'open'")!.id;
hub.answer(card, { choice: 1, by: "本人" }, at(3));
const next = hub.claimNext("w1", "c2", at(4))!;
hub.finish(next.run, next.token, { outcome: "done", summary: "做完了" }, at(5));
hub.ingest("app", { id: "ss:x", type: "no.rule.here", subject: "#x" }, at(6));
hub.ingest("app", { id: "ss:2", type: "feedback.new", subject: "#2" }, at(7));
const second = hub.claimNext("w1", "c3", at(7))!;
hub.finish(second.run, second.token, { outcome: "done", notice: [{ title: "记录", text: "一条", key: "n2" }] }, at(8));
const notice = hub.one<{ id: number }>("SELECT id FROM cards WHERE kind = 'notice' AND state = 'open'")!.id;
hub.delivered("chat", notice, 1, "om_1", at(9));
hub.failed("chat", notice, 1, "发送失败", at(10));
hub.tick(at(11));
hub.sweep(at(12));

test("every /v1/state answer matches the schema the clients code against", () => {
  for (const state of [hub.stateOf(at(20)), hub.stateOf(at(20), 1)]) {
    const problems = check(state, { $ref: "#/$defs/state" });
    assert.deepEqual(problems, [], JSON.stringify(problems, null, 1));
  }
});

test("the fields a client reads are the ones the schema names", () => {
  const state = hub.stateOf(at(20)) as any;
  assert.equal(
    state.lines.some((line: any) => line.name === "意见" && typeof line.disabled === "boolean"),
    true,
  );
  assert.equal(
    state.runs.some((run: any) => run.state === "done" && run.summary === "做完了"),
    true,
  );
  assert.equal(
    state.unrouted.some((event: any) => event.type === "no.rule.here"),
    true,
  );
  assert.ok(state.totals.done >= 2);
  assert.ok("severity" in state.cards[0] || "severity" in state.recentCards[0]);
});

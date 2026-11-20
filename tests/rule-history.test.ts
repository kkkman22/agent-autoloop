// A rule's history must keep the same rows and linked events as state, across the page boundary, without listing active runs.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { hubClient } from "../protocol/client.ts";
import { at, setup } from "./helpers.ts";

setup("rule-history");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");

test("a rule's finished runs page back with their events, even across newer unfinished work", async () => {
  const server = serve(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const owner = hubClient(base, hub.addKey("owner", "reader"));
    for (let i = 0; i < 21; i++) {
      hub.ingest("app", { id: String(i), type: "feedback.new", subject: String(i) }, at(i));
      const job = hub.claimNext("w1", String(i), at(i))!;
      hub.finish(job.run, job.token, { outcome: "done" }, at(i));
    }
    hub.ingest("app", { id: "pending", type: "feedback.new", subject: "pending" }, at(22));
    const expected = (await owner.state()).runs.filter((run: any) => run.rule === "意见" && run.state === "done");
    const first = await owner.ruleRuns("意见");
    assert.deepEqual(first.runs, expected.slice(0, 20));
    assert.equal(first.nextBefore, expected[19].id);
    const next = await owner.ruleRuns("意见", first.nextBefore);
    assert.deepEqual(next.runs, expected.slice(20));
    assert.equal(next.nextBefore, null);
    assert.deepEqual((await owner.ruleRuns("absent")).runs, []);
    await assert.rejects(hubClient(base, hub.addKey("source", "app")).ruleRuns("意见"), { status: 401 });
    await assert.rejects(owner.ruleRuns("意见", 0), { status: 400 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

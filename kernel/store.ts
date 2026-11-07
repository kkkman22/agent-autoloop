// The log and its expendable projection commit together. Only this module appends facts.
import type { DatabaseSync } from "node:sqlite";
import { Conflict } from "./errors.ts";
import { evolve, initialize, statement, View, type Fact } from "./evolve.ts";

/** A projection being rebuilt is saved under this mark and its format, so a rebuild stopped partway carries on. */
const BUILDING = "building:";
/** Facts applied in one transaction of a rebuild: a stop loses at most this many, and committing them costs little. */
export const REBUILD_CHUNK = 50_000;
export type Rebuilding = { chunk?: number; progress?: (done: number, total: number) => void };

export function readLog(db: DatabaseSync, after = 0): Fact[] {
  return [...iterateLog(db, after)];
}
export function* iterateLog(db: DatabaseSync, after = 0, limit = -1): Generator<Fact> {
  for (const row of db.prepare("SELECT fact FROM facts WHERE seq > ? ORDER BY seq LIMIT ?").iterate(after, limit))
    yield JSON.parse(String(row.fact));
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const saved = (db: DatabaseSync) => statement(db, "SELECT seq,next,format FROM projection_meta WHERE id=1").get();
const lastSeq = (db: DatabaseSync) => Number(statement(db, "SELECT COALESCE(MAX(seq),0) AS seq FROM facts").get()!.seq);

/** Rebuilds the projection from the first fact, a chunk per transaction; only the last one marks it as `format`. */
export function rebuild(db: DatabaseSync, format = "", options: Rebuilding = {}): View {
  initialize(db);
  transaction(db, () => evolve(new View(db, 0, {}, BUILDING + format), [], db, true));
  return carryOn(db, format, options);
}

function carryOn(db: DatabaseSync, format: string, { chunk = REBUILD_CHUNK, progress }: Rebuilding): View {
  for (;;) {
    let restart = false;
    let finished: View | undefined;
    let done = 0;
    let total = 0;
    transaction(db, () => {
      // Read inside the transaction: another process may have carried the same rebuild further meanwhile.
      const at = saved(db);
      total = lastSeq(db);
      if (at?.format === format) {
        finished = new View(db, Number(at.seq), JSON.parse(String(at.next)), format);
        done = finished.seq;
        return;
      }
      if (at?.format !== BUILDING + format) {
        restart = true;
        return;
      }
      const from = new View(db, Number(at.seq), JSON.parse(String(at.next)), BUILDING + format);
      const view = evolve(from, iterateLog(db, from.seq, chunk), db);
      done = view.seq;
      if (view.seq < total) return;
      statement(db, "UPDATE projection_meta SET format=? WHERE id=1").run(format);
      finished = new View(db, view.seq, view.next, format);
    });
    if (restart) return rebuild(db, format, { chunk, progress });
    progress?.(done, total);
    if (finished) return finished;
  }
}

export function openView(db: DatabaseSync, format: string, options: Rebuilding = {}) {
  initialize(db);
  const at = saved(db);
  if (at?.format === format) return new View(db, Number(at.seq), JSON.parse(String(at.next)), format);
  if (at?.format === BUILDING + format) return carryOn(db, format, options);
  return rebuild(db, format, options);
}

export function commit(db: DatabaseSync, view: View, produce: () => Fact[]): View {
  // The checkpoint read below lives in a table evolve would otherwise only create on the first write.
  initialize(db);
  return transaction(db, () => {
    const latest = lastSeq(db);
    if (latest !== view.seq) throw new Conflict("日志已变化，请重读后再提交");
    // A view opened before a rebuild began would land its facts on a projection that is not the one it read.
    const at = saved(db);
    if (at && at.format !== view.format) throw new Conflict("日志已变化，请重读后再提交");
    const facts = produce();
    if (!facts.length) return view;
    const insert = statement(db, "INSERT INTO facts(seq,fact) VALUES (?,?)");
    for (const fact of facts) insert.run(fact.seq, JSON.stringify(fact));
    return evolve(view, facts, db);
  });
}
/** Reads the view holding the write lock: commands write to this database too, so one read before it can be stale. */
export function commitLatest(db: DatabaseSync, format: string, produce: (view: View) => Fact[]): View {
  return transaction(db, () => {
    const view = openView(db, format);
    return commit(db, view, () => produce(view));
  });
}

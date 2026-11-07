// Fixture resets only; production writes go through decide/commit/evolve.
import { evolve, keyOf, rows, type Table } from "../kernel/evolve.ts";
import { db, getView } from "../host/runtime.ts";
export { all, one } from "../host/runtime.ts";

/** Clears a table for a fixture, straight into the projection: test scaffolding, not a door of the hub. */
export function fixtureClear(table: Table) {
  const latest = getView();
  const changes = rows(latest, table)
    .map((row) => keyOf(table, row))
    .map((key) => ({ table, key, row: null }));
  evolve(latest, [{ version: 1, seq: latest.seq, at: 0, type: "fixture", changes }], db);
}
export const run = (sql: string) => {
  const match = /^DELETE FROM (\w+)$/.exec(sql);
  if (!match) throw new Error(sql);
  fixtureClear(match[1] as Table);
};

// The one place a hub database is opened. Its card index is an expression over the master key, so a connection that
// doesn't name that key can't even read the schema: the hub, a backup, a repair script all come through here rather
// than opening the file themselves.
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { credential, digest } from "../kernel/credentials.ts";

export function openDatabase(file: string, secret: string, { readOnly = false }: { readOnly?: boolean } = {}) {
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  const environment = { secret, publicUrl: "" };
  const token = (id: SQLOutputValue, at: SQLOutputValue) => credential(environment, "card", id, at);
  db.function("card_token", { deterministic: true }, token);
  db.function("card_hash", { deterministic: true }, (id, at) => digest(token(id, at)));
  return db;
}

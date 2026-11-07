// Which code a persisted projection belongs to, and which master key it was built with. The log alone rebuilds the
// projection, so a mismatch is only a slow first start; a backup records this value so a restore can say which.
import { readFileSync } from "node:fs";
import { digest } from "../kernel/credentials.ts";

/** Only the files that decide what's stored count, whole: what they do is spread across helpers and constants. The
 * views (host/state.ts) are made anew at every start and need no rebuild; this file and runtime.ts don't decide it. */
const SOURCES = ["../kernel/evolve.ts", "../kernel/credentials.ts"];
/** The one index that reaches into stored rows: runtime.ts creates it, and it counts into the format here, once. */
export const CARD_HASH_INDEX =
  "CREATE INDEX IF NOT EXISTS projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'";

/** Tokens live in the projection as hashes of this key's derivations: the same data under another key is another projection. */
export const formatOf = (secret: string) =>
  digest(
    [...SOURCES.map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))].join("\n") +
      CARD_HASH_INDEX +
      digest(secret),
  );

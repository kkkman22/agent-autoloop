// Which code a persisted projection belongs to, and which master key it was built with. The log alone rebuilds the
// projection, so a mismatch is only a slow first start; a backup records this value so a restore can say which.
import { readFileSync } from "node:fs";
import { digest } from "../kernel/credentials.ts";

/** Everything that decides what the projection looks like, this file included. */
const SOURCES = [
  "../kernel/evolve.ts",
  "../kernel/schema.sql",
  "../kernel/credentials.ts",
  "./runtime.ts",
  "./fingerprint.ts",
];

/** Tokens live in the projection as hashes of this key's derivations: the same data under another key is another projection. */
export const formatOf = (secret: string) =>
  digest([...SOURCES.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")), digest(secret)].join("\n"));

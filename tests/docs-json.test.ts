// Failure modes: a JSON example in a page users copy from that doesn't parse, so what they paste fails; a ```jsonc
// fence coming back, advertising a format nothing in this repo reads. The pages here are the ones users copy config
// out of, so scripts/ci-scope.sh gives a change to any of them the unit tests.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const pages = [
  "README.md",
  "README.en.md",
  "docs/protocol.md",
  "docs/plugins.md",
  "skills/agent-autoloop/SKILL.md",
  ...readdirSync(join(root, "examples"), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".md"))
    .map((file) => join("examples", file)),
].sort();

/** Every fenced block, with the block's own line number. A fence closes only on exactly its own marker. */
function fences(text: string) {
  const lines = text.split("\n");
  const found: { lang: string; body: string; line: number }[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const opening = /^(`{3,})(\S*)$/.exec(lines[at]);
    if (!opening) continue;
    const line = at + 1;
    const body: string[] = [];
    for (at += 1; at < lines.length && lines[at] !== opening[1]; at += 1) body.push(lines[at]);
    found.push({ lang: opening[2], body: `${body.join("\n")}\n`, line });
  }
  return found;
}

test("every JSON example in the pages users copy from parses, and none of them is JSONC", () => {
  assert.ok(pages.includes("docs/protocol.md"), "the pages that carry examples");
  let checked = 0;
  for (const page of pages) {
    for (const { lang, body, line } of fences(readFileSync(join(root, page), "utf8"))) {
      assert.ok(!["jsonc", "json5"].includes(lang), `${page}:${line} 用了代码不认的 ${lang}；注释写在围栏外面`);
      if (lang !== "json") continue;
      checked += 1;
      try {
        JSON.parse(body);
      } catch (error) {
        assert.fail(`${page}:${line} 的示例读不了：${(error as Error).message}`);
      }
    }
  }
  assert.ok(checked >= 10, `找到 ${checked} 个 JSON 示例，太少了`);
});

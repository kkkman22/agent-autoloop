// Failure modes: a terminal control sequence in someone else's words moves the cursor, sets the window title or hides
// what follows; stripping takes the line structure with it; --raw stops being raw.
import assert from "node:assert/strict";
import { test } from "node:test";
import { printable, printer } from "../cli/plain-text.ts";

test("control sequences are removed and ordinary text, newlines and tabs are kept", () => {
  const noisy = "\u001b[31m红\u001b[0m\u001b]0;title\u0007\u001b[2K\u0007\u0008x\tdone\nnext";
  assert.equal(printable(noisy), "红x\tdone\nnext");
  assert.equal(printable("普通文字 emoji 😀"), "普通文字 emoji 😀");
  assert.equal(printable("\u001b]8;;https://x\u001b\\click\u001b]8;;\u001b\\"), "click");
});
test("printer passes text through untouched only when raw", () => {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...words: unknown[]) => lines.push(words.join(" "));
  try {
    printer()("\u001b[31m红");
    printer(true)("\u001b[31m红");
    printer()("x", 42);
  } finally {
    console.log = real;
  }
  assert.deepEqual(lines, ["红", "\u001b[31m红", "x 42"]);
});

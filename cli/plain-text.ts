// Words that came from somewhere else are shown as words: terminal control sequences in them must not drive the terminal.
export function printable(text: string) {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** console.log, with anything from elsewhere made printable unless the person asked for the raw text. */
export function printer(raw = false) {
  return (...words: unknown[]) =>
    console.log(...(raw ? words : words.map((word) => (typeof word === "string" ? printable(word) : word))));
}

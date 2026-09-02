/**
 * Shrink tool output for LLM consumption without losing the failure signal:
 * keep the head and tail, and surface lines that look like errors / failing tests.
 */
export interface CompressedOutput {
  summary: string;
  errorLines: string[];
  head: string;
  tail: string;
  originalLines: number;
  originalBytes: number;
}

const ERROR_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bfail(ed|ure)?\b/i,
  /✗|✖|×|❌|FAIL\b/,
  /AssertionError|TypeError|ReferenceError|SyntaxError|RangeError/,
  /^\s*at .+\(.+:\d+:\d+\)$/,
  /error TS\d+/,
  /Cannot find module/,
  /Expected .* (Received|but got)/i,
  /Tests?:\s+\d+ failed/,
  /^\s*[-+]\s{2}/,
];

const NOISE_PATTERNS: RegExp[] = [/^\s*$/, /^Progress:/, /^\s*\d+%\s/, /^Downloading/, /^Resolving/];

export function compressOutput(text: string, opts: { headLines?: number; tailLines?: number; maxErrorLines?: number } = {}): CompressedOutput {
  const headN = opts.headLines ?? 20;
  const tailN = opts.tailLines ?? 40;
  const maxErr = opts.maxErrorLines ?? 60;
  const lines = text.split(/\r?\n/);
  const meaningful = lines.filter((l) => !NOISE_PATTERNS.some((re) => re.test(l)));

  const errorLines: string[] = [];
  for (let i = 0; i < meaningful.length && errorLines.length < maxErr; i++) {
    const line = meaningful[i] ?? "";
    if (ERROR_PATTERNS.some((re) => re.test(line))) errorLines.push(`${i + 1}: ${line.trimEnd()}`);
  }

  const head = meaningful.slice(0, headN).join("\n");
  const tail = meaningful.length > headN ? meaningful.slice(-tailN).join("\n") : "";
  const summary = [
    `${lines.length} lines / ${Buffer.byteLength(text, "utf8")} bytes`,
    errorLines.length > 0 ? `${errorLines.length} error-like lines` : "no error-like lines",
  ].join("; ");

  return { summary, errorLines, head, tail, originalLines: lines.length, originalBytes: Buffer.byteLength(text, "utf8") };
}

/** Render for a prompt: bounded, error-first. */
export function renderCompressed(c: CompressedOutput, maxChars = 6000): string {
  const parts = [`[${c.summary}]`];
  if (c.errorLines.length > 0) parts.push("--- error-like lines ---", ...c.errorLines);
  parts.push("--- head ---", c.head);
  if (c.tail) parts.push("--- tail ---", c.tail);
  const joined = parts.join("\n");
  return joined.length <= maxChars ? joined : joined.slice(0, maxChars - 20) + "\n…[truncated]";
}

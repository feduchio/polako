import { CardSchema, type Card } from "./types.js";
import { PolishError } from "../shared/errors.js";

const HEADER = /^([A-Za-z][A-Za-z_-]*):[ \t]*(.*)$/;
const KNOWN_HEADERS = new Set(["id", "title", "depends", "files"]);
const ACCEPT_START = /^(?:accept(?:ance)?(?: criteria)?)\s*:\s*/i;
const NOTES_START = /^notes?\s*:\s*/i;
const ACCEPT_HEADING = /^#{1,6}\s*accept(?:ance)?(?: criteria)?\s*:?\s*$/i;
const NOTES_HEADING = /^#{1,6}\s*notes?\s*:?\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim())
    .filter((item) => item.length > 0);
}

/** `a; b` and `- a` / `* a` / `1. a` lists are criteria; a plain paragraph is split on `;`. */
function criteria(lines: readonly string[]): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (text === "") return;
    for (const part of text.split(/;\s+/)) {
      const piece = part.trim();
      if (piece !== "") out.push(piece);
    }
  };
  for (const raw of lines) {
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet !== null) {
      flush();
      const text = (bullet[1] ?? "").trim();
      if (text !== "") out.push(text);
    } else if (raw.trim() === "") {
      flush();
    } else {
      paragraph.push(raw.trim());
    }
  }
  flush();
  return out;
}

/**
 * Parse one card. Throws a `CONFIG_ERROR` that names the card and what is wrong; nothing here
 * guesses, because a card that is silently misread runs the wrong work all night.
 */
export function parseCard(text: string, source?: string): Card {
  const where = source === undefined ? "card" : `card ${source}`;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  const headers = new Map<string, string>();
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") break;
    const match = HEADER.exec(line);
    if (match === null || !KNOWN_HEADERS.has((match[1] ?? "").toLowerCase())) {
      throw new PolishError("CONFIG_ERROR", `${where}: line ${String(index + 1)} is not a header (id:, title:, depends:, files:); a blank line must end the header: ${JSON.stringify(line.slice(0, 80))}`, { source });
    }
    headers.set((match[1] ?? "").toLowerCase(), (match[2] ?? "").trim());
    index += 1;
  }
  for (const required of ["id", "title", "files"]) {
    if ((headers.get(required) ?? "") === "") throw new PolishError("CONFIG_ERROR", `${where}: missing \`${required}:\` header`, { source });
  }

  const goal: string[] = [];
  const accept: string[] = [];
  const notes: string[] = [];
  let section: "goal" | "accept" | "notes" = "goal";
  for (const line of lines.slice(index)) {
    const trimmed = line.trim();
    const startAccept = ACCEPT_START.exec(trimmed);
    const startNotes = NOTES_START.exec(trimmed);
    if (ACCEPT_HEADING.test(trimmed)) {
      section = "accept";
      continue;
    }
    if (NOTES_HEADING.test(trimmed)) {
      section = "notes";
      continue;
    }
    if (startAccept !== null) {
      section = "accept";
      accept.push(trimmed.slice(startAccept[0].length));
      continue;
    }
    if (startNotes !== null) {
      section = "notes";
      notes.push(trimmed.slice(startNotes[0].length));
      continue;
    }
    if (ANY_HEADING.test(trimmed) && section !== "goal") {
      // Another heading ends the acceptance/notes section.
      section = "goal";
    }
    (section === "accept" ? accept : section === "notes" ? notes : goal).push(line);
  }

  const acceptance = criteria(accept);
  if (acceptance.length === 0) {
    throw new PolishError("CONFIG_ERROR", `${where} ${headers.get("id") ?? ""}: no acceptance criteria; add an \`Accept:\` paragraph (or an "Acceptance" list) saying what must hold`, { source });
  }
  const goalText = goal.join("\n").trim();
  const parsed = CardSchema.safeParse({
    id: headers.get("id"),
    title: headers.get("title"),
    depends: splitList(headers.get("depends") ?? ""),
    files: splitList(headers.get("files") ?? ""),
    goal: goalText,
    acceptance,
    ...(notes.join("\n").trim() === "" ? {} : { notes: notes.join("\n").trim() }),
    ...(source === undefined ? {} : { source }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "card");
    const detail = field === "goal" ? "the body has no description before `Accept:`" : (issue?.message ?? "invalid");
    throw new PolishError("CONFIG_ERROR", `${where} ${headers.get("id") ?? ""}: ${field}: ${detail}`, { source });
  }
  return parsed.data;
}

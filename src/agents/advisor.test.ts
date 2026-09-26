import { describe, expect, it } from "vitest";
import { AdvisorNotes, parseAdvisorReply } from "./advisor.js";

describe("advisor", () => {
  it("reads a note or silence, and nothing malformed", () => {
    expect(parseAdvisorReply('{"note": null}')).toBeNull();
    expect(parseAdvisorReply('{"note": {"level": "blocker", "text": "the test uses Jest globals under node:test"}}'))
      .toEqual({ level: "blocker", text: "the test uses Jest globals under node:test" });
    expect(parseAdvisorReply("```json\n{\"note\": {\"level\": \"nit\", \"text\": \"name\"}}\n```")).toEqual({ level: "nit", text: "name" });
    expect(parseAdvisorReply('{"note": {"level": "urgent", "text": "x"}}')).toBeNull();
    expect(parseAdvisorReply("not json")).toBeNull();
  });

  it("drops content-free and repeated notes and caps them, never a blocker", () => {
    const notes = new AdvisorNotes(2);
    expect(notes.accept({ level: "concern", text: "LGTM" })).toBeNull();
    expect(notes.accept({ level: "concern", text: "edits the wrong file" })).toBe("[advisor concern] edits the wrong file");
    expect(notes.accept({ level: "concern", text: "Edits the  wrong file" })).toBeNull();
    expect(notes.accept({ level: "nit", text: "a name" })).toBe("[advisor nit] a name");
    expect(notes.accept({ level: "nit", text: "another name" })).toBeNull();
    expect(notes.accept({ level: "blocker", text: "finishes without running the check" })).toBe("[advisor blocker] finishes without running the check");
  });
});

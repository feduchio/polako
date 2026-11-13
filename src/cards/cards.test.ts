import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeGuidance, modelNotesFor } from "./notes.js";
import { cardAcceptanceChecks, cardComplexity, cardDescription, cardKind, registerCards, validateCards } from "./plan.js";
import { cardsDirectory, loadCards, looksLikeCards } from "./load.js";
import { matchesAnyGlob, scopeViolations } from "./glob.js";
import { parseCard } from "./parse.js";
import type { Card } from "./types.js";

const N02 = `id: N02
title: Front block starts fighting when the first tower is placed
depends:
files: domain/world/world.ts, domain/world/world.test.ts

In \`domain/world/world.ts\` the status \`fighting\` is never set. Make \`placeTower\` switch it.

Accept: tests for waiting→fighting on the first tower, past blocks unchanged, out-of-range spot rejected, purity still holds; existing tests pass unchanged.
`;

const N03 = `id: N03
title: Placement rules
depends: N02
files: domain/placement/*.ts

New \`domain/placement/placement.ts\`.

Accept: tests for each refusal reason, fixed vs growing cost, and that a successful check does not change the wallet.
`;

function card(id: string, depends: string[] = [], files = ["src/**"]): Card {
  return { id, title: `Card ${id}`, depends, files, goal: "Do it.", acceptance: ["It works."] };
}

describe("parseCard (td format)", () => {
  it("reads headers, goal and acceptance criteria", () => {
    const parsed = parseCard(N02, "tasks/N02.md");
    expect(parsed).toMatchObject({
      id: "N02",
      title: "Front block starts fighting when the first tower is placed",
      depends: [],
      files: ["domain/world/world.ts", "domain/world/world.test.ts"],
      source: "tasks/N02.md",
    });
    expect(parsed.goal).toContain("placeTower");
    expect(parsed.acceptance).toEqual([
      "tests for waiting→fighting on the first tower, past blocks unchanged, out-of-range spot rejected, purity still holds",
      "existing tests pass unchanged.",
    ]);
  });

  it("reads a comma-separated depends list", () => {
    expect(parseCard(N03).depends).toEqual(["N02"]);
    expect(parseCard(N03.replace("depends: N02", "depends: N02, N05 ,`N07`")).depends).toEqual(["N02", "N05", "N07"]);
  });

  it("accepts an Acceptance heading with a bullet list and a Notes section", () => {
    const parsed = parseCard(`id: A1\ntitle: T\nfiles: a.ts\n\nGoal text.\n\n## Acceptance\n- first\n- second\n\n## Notes\nuse the helper\n`);
    expect(parsed.acceptance).toEqual(["first", "second"]);
    expect(parsed.notes).toBe("use the helper");
    expect(parsed.goal).toBe("Goal text.");
  });

  it.each([
    ["no id", "title: T\nfiles: a.ts\n\nBody.\n\nAccept: x\n", /missing `id:`/],
    ["no files", "id: A\ntitle: T\n\nBody.\n\nAccept: x\n", /missing `files:`/],
    ["no acceptance", "id: A\ntitle: T\nfiles: a.ts\n\nBody only.\n", /no acceptance criteria/],
    ["no goal", "id: A\ntitle: T\nfiles: a.ts\n\nAccept: x\n", /no description/],
    ["stray header line", "id: A\ntitle: T\nfiles: a.ts\nwhoops this is text\n\nBody.\n\nAccept: x\n", /not a header/],
    ["bad id", "id: bad id!\ntitle: T\nfiles: a.ts\n\nBody.\n\nAccept: x\n", /card id may contain/],
  ])("rejects %s with a clear error", (_name, text, message) => {
    expect(() => parseCard(text, "x.md")).toThrow(message);
  });
});

describe("file scope globs (td semantics)", () => {
  it("`*` stays in a directory, `**` crosses directories", () => {
    expect(matchesAnyGlob("domain/placement/placement.ts", ["domain/placement/*.ts"])).toBe(true);
    expect(matchesAnyGlob("domain/placement/deep/x.ts", ["domain/placement/*.ts"])).toBe(false);
    expect(matchesAnyGlob("domain/placement/deep/x.ts", ["domain/**/*.ts"])).toBe(true);
    expect(matchesAnyGlob("domain/placementXts", ["domain/placement.ts"])).toBe(false);
  });

  it("lists the changed files the card does not allow", () => {
    expect(scopeViolations(["domain/world/world.ts", "package.json", "./domain/world/world.test.ts"], ["domain/world/world.ts", "domain/world/world.test.ts"])).toEqual(["package.json"]);
    expect(scopeViolations([], ["a"])).toEqual([]);
  });
});

describe("validateCards", () => {
  it("accepts a DAG", () => {
    expect(() => { validateCards([card("A"), card("B", ["A"]), card("C", ["A", "B"])]); }).not.toThrow();
  });

  it("names unknown dependency ids", () => {
    expect(() => { validateCards([card("A", ["Z"])]); }).toThrow(/card A depends on unknown card Z/);
  });

  it("names the cycle", () => {
    expect(() => { validateCards([card("A", ["C"]), card("B", ["A"]), card("C", ["B"])]); }).toThrow(/dependency cycle: A -> C -> B -> A/);
    expect(() => { validateCards([card("A", ["A"])]); }).toThrow(/depends on itself/);
  });

  it("names duplicate ids", () => {
    expect(() => { validateCards([card("A"), card("A")]); }).toThrow(/duplicate card id A/);
  });
});

describe("registerCards", () => {
  const set = [card("A"), card("B", ["A"]), card("C", ["B"])];

  it("keeps everything without --only", () => {
    const registration = registerCards(set, { brief: "Be careful.", briefSource: "brief.md" });
    expect(registration.cards.map((c) => c.id)).toEqual(["A", "B", "C"]);
    expect(registration).toMatchObject({ brief: "Be careful.", briefSource: "brief.md", droppedDependencies: [] });
  });

  it("selects a subset and records the dependencies it dropped", () => {
    const registration = registerCards(set, { only: ["B", "C"] });
    expect(registration.cards.map((c) => [c.id, c.depends])).toEqual([["B", []], ["C", ["B"]]]);
    expect(registration.droppedDependencies).toEqual([{ card: "B", dependsOn: "A" }]);
  });

  it("rejects an unknown --only id and still validates the whole set", () => {
    expect(() => registerCards(set, { only: ["Q"] })).toThrow(/--only names unknown card\(s\): Q/);
    expect(() => registerCards([card("A", ["Z"])], { only: ["A"] })).toThrow(/unknown card Z/);
  });
});

describe("card -> task attributes", () => {
  it("derives kind, complexity and test-file checks", () => {
    expect(cardKind({ ...card("A"), title: "Fix the placement bug" })).toBe("bugfix");
    expect(cardKind({ ...card("A"), title: "Rename the grid helper" })).toBe("refactor");
    expect(cardKind(card("A"))).toBe("feature");
    expect(cardComplexity({ ...card("A"), files: ["a.test.ts"] })).toBe("trivial");
    expect(cardComplexity({ ...card("A"), files: ["a.ts", "b.ts"] })).toBe("normal");
    expect(cardComplexity({ ...card("A"), files: ["a/**"] })).toBe("complex");
    expect(cardAcceptanceChecks({ ...card("A"), files: ["domain/combat/content-invariants.test.ts", "domain/**/*.test.ts", "x.ts"] })).toEqual([
      { kind: "test_file", path: "domain/combat/content-invariants.test.ts" },
    ]);
  });

  it("puts the write scope in the description the worker reads", () => {
    const text = cardDescription({ ...card("N02"), files: ["a.ts", "b.ts"], notes: "careful" }, ["Placement rules"]);
    expect(text).toContain("Card N02:");
    expect(text).toContain("Files you may change (the gate rejects any other changed file): a.ts, b.ts");
    expect(text).toContain("Notes: careful");
    expect(text).toContain("Builds on: Placement rules");
  });
});

describe("model notes", () => {
  const notes = { ornith: "notes/ornith.md", qwen: "notes/qwen.md", "swift-1.5-qwen3.8-27b": "notes/swift.md", other: "notes/other.md" };

  it("matches by exact key, key prefix, then lineage; each file once", () => {
    expect(modelNotesFor(notes, "ornith-ai/ornith-1.5-35b-a3b", "qwen")).toEqual(["notes/ornith.md", "notes/qwen.md"]);
    expect(modelNotesFor(notes, "swift-1.5-qwen3.8-27b", "qwen")).toEqual(["notes/swift.md", "notes/qwen.md"]);
    expect(modelNotesFor(notes, "gpt-oss-20b", "openai")).toEqual([]);
  });

  it("composes brief and notes", () => {
    expect(composeGuidance(" brief ", ["a", " ", "b"])).toBe("brief\n\na\n\nb");
    expect(composeGuidance("", [])).toBe("");
  });
});

describe("loading cards from the file system", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), "polako-cards-"));
    dirs.push(root);
    mkdirSync(join(root, "tasks"));
    writeFileSync(join(root, "tasks", "N02-a.md"), N02);
    writeFileSync(join(root, "tasks", "N03-b.md"), N03);
    writeFileSync(join(root, "tasks", "README.md"), "# Cards\nnot a card\n");
    writeFileSync(join(root, "notes.md"), "just prose\n");
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    writeFileSync(join(root, "repo", "README.md"), "id: X\n");
    return root;
  }

  it("loads a single file, a directory (skipping README) and a glob", () => {
    const root = tree();
    expect(loadCards("tasks/N02-a.md", root).map((c) => c.id)).toEqual(["N02"]);
    expect(loadCards("tasks", root).map((c) => c.id)).toEqual(["N02", "N03"]);
    expect(loadCards("tasks/N0*.md", root).map((c) => c.id)).toEqual(["N02", "N03"]);
    expect(loadCards("tasks/N03-*.md", root).map((c) => c.id)).toEqual(["N03"]);
    expect(loadCards(join(root, "tasks"), "/").map((c) => c.id)).toEqual(["N02", "N03"]);
  });

  it("tags cards with their source and errors clearly on nothing found", () => {
    const root = tree();
    expect(loadCards("tasks", root)[0]?.source).toBe(join("tasks", "N02-a.md"));
    expect(() => loadCards("nope", root)).toThrow(/task cards not found: nope/);
    expect(() => loadCards("tasks/Z*.md", root)).toThrow(/no task cards/);
  });

  it("names the file of a broken card", () => {
    const root = tree();
    writeFileSync(join(root, "tasks", "N09-bad.md"), "id: N09\ntitle: t\nfiles: a\n\nbody\n");
    expect(() => loadCards("tasks", root)).toThrow(/N09-bad\.md.*no acceptance criteria/);
  });

  it("tells cards from a project or a mission", () => {
    const root = tree();
    expect(looksLikeCards("tasks", root)).toBe(true);
    expect(looksLikeCards("tasks/N02-a.md", root)).toBe(true);
    expect(looksLikeCards("tasks/N0*.md", root)).toBe(true);
    expect(looksLikeCards("repo", root)).toBe(false); // a git repository is a project
    expect(looksLikeCards(".", join(root, "repo"))).toBe(false);
    expect(looksLikeCards("add a dark mode", root)).toBe(false);
    expect(looksLikeCards("missing.md", root)).toBe(false);
    expect(looksLikeCards("tasks/Z*.md", root)).toBe(false);
    expect(cardsDirectory("tasks/N0*.md", root)).toBe(join(root, "tasks"));
    expect(cardsDirectory("tasks/N02-a.md", root)).toBe(join(root, "tasks"));
  });
});

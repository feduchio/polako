import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { PolishError } from "../shared/errors.js";
import { ProtocolRegistry } from "./loader.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "polish-proto-diag-"));
  dirs.push(dir);
  return dir;
}

function writeRaw(dir: string, folder: string, contents: string): string {
  mkdirSync(join(dir, folder), { recursive: true });
  const path = join(dir, folder, "SKILL.md");
  writeFileSync(path, contents, "utf8");
  return path;
}

function skill(name: string, extra: { kind?: string; omitKind?: boolean } = {}): string {
  return `---
name: ${name}
description: ${name} protocol for tests
applies_to:
  - worker
${extra.omitKind === true ? "" : `kind: ${extra.kind ?? "task"}\n`}budget_tokens: 10
resources: []
---

# ${name}

body
`;
}

function loadError(dir: string): PolishError {
  try {
    ProtocolRegistry.load(dir);
  } catch (error) {
    if (error instanceof PolishError) return error;
    throw new Error(`expected a PolishError, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected ProtocolRegistry.load to throw");
}

describe("ProtocolRegistry.load names the offending file", () => {
  it("attaches the absolute SKILL.md path to a name/directory mismatch", () => {
    const dir = root();
    const path = writeRaw(dir, "bugfix", skill("feature"));
    const error = loadError(dir);
    expect(error.code).toBe("INVARIANT_VIOLATION");
    expect(error.details["skillPath"]).toBe(path);
    // MC2: the sentence saying what was wrong survives the path being attached.
    expect(error.message).toContain('"feature"');
    expect(error.message).toContain('"bugfix"');
  });

  // AC2': the *mismatch* branch, not the duplicate one. A folder claiming a name that belongs to
  // another folder is a mismatch first, so `byName.has` is unreachable — recorded as finding 49.
  it("names the folder whose SKILL.md claims another folder's name", () => {
    const dir = root();
    writeRaw(dir, "a-dup", skill("a-dup"));
    const second = writeRaw(dir, "b-dup", skill("a-dup"));
    const error = loadError(dir);
    expect(error.code).toBe("INVARIANT_VIOLATION");
    expect(error.details["skillPath"]).toBe(second);
  });

  it("converts a frontmatter schema rejection from ZodError to PolishError with the path", () => {
    const dir = root();
    const path = writeRaw(dir, "no-kind", skill("no-kind", { omitKind: true }));
    let thrown: unknown;
    try {
      ProtocolRegistry.load(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PolishError);
    expect(thrown).not.toBeInstanceOf(ZodError);
    expect((thrown as PolishError).code).toBe("INVALID_ARGUMENT");
    expect((thrown as PolishError).details["skillPath"]).toBe(path);
    expect((thrown as PolishError).cause).toBeInstanceOf(ZodError);
  });

  it("attaches the path to a malformed-frontmatter rejection", () => {
    const dir = root();
    const path = writeRaw(dir, "no-frontmatter", "just a body\n");
    const error = loadError(dir);
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.details["skillPath"]).toBe(path);
  });

  it("carries the root once, not twice, when the root itself is missing", () => {
    const dir = root();
    const missing = join(dir, "absent");
    const error = loadError(missing);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.details["protocolsRoot"]).toBe(missing);
    expect(error.details["skillPath"]).toBeUndefined();
    expect(error.message.split(missing)).toHaveLength(2);
  });

  it("converts a native scandir failure into a PolishError naming the root", () => {
    const dir = root();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const error = loadError(locked);
      expect(error.code).toBe("IO_ERROR");
      expect(error.details["protocolsRoot"]).toBe(locked);
      expect(error.cause).toBeInstanceOf(Error);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("still loads a well-formed directory", () => {
    const dir = root();
    writeRaw(dir, "bugfix", skill("bugfix"));
    expect(ProtocolRegistry.load(dir).list().map((p) => p.meta.name)).toEqual(["bugfix"]);
  });
});

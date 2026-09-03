import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "./cliEntry.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isMainModule", () => {
  it("treats a symlink to the entry file as the process entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-entry-"));
    dirs.push(dir);
    const real = join(dir, "index.js");
    const link = join(dir, "polish");
    writeFileSync(real, "export {}\n");
    symlinkSync(real, link);
    expect(isMainModule(pathToFileURL(real).href, link)).toBe(true);
    expect(isMainModule(pathToFileURL(real).href, real)).toBe(true);
  });
});

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";

const cliSource = fileURLToPath(new URL("./index.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx/esm"));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI invocation outside the repository cwd", () => {
  it("prints help from an unrelated working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "polish-cli-cwd-"));
    dirs.push(cwd);
    const output = execFileSync(process.execPath, ["--import", tsxLoader, cliSource, "--help"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, POLAKO_HOME: cwd },
    });
    expect(output).toContain("polako status");
    expect(output).toContain("polako watch");
    expect(output).toContain("pnpm cli:link");
  });

  it("runs when argv[1] is a symlink to the CLI entry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "polish-cli-link-cwd-"));
    const bin = mkdtempSync(join(tmpdir(), "polish-cli-link-bin-"));
    dirs.push(cwd, bin);
    const shim = join(bin, "polish");
    symlinkSync(cliSource, shim);
    const output = execFileSync(process.execPath, ["--import", tsxLoader, shim, "--help"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, POLAKO_HOME: cwd },
    });
    expect(output).toContain("polako log <run-id>");
  });

  it("resolves the polish command name from PATH in an unrelated directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "polish-cli-path-"));
    const bin = mkdtempSync(join(tmpdir(), "polish-cli-bin-"));
    dirs.push(cwd, bin);
    const shim = join(bin, "polish");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" --import "${tsxLoader}" "${cliSource}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const output = execFileSync("polish", ["--help"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, POLAKO_HOME: cwd },
    });
    expect(output).toContain("polako watch <run-id>");
  });

  it("help mentions polishd via the documented link path rather than a cwd-relative binary", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli(["help"]);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    write.mockRestore();
    expect(output).toContain("cli:link");
  });
});

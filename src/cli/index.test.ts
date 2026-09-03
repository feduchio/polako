import { describe, expect, it, vi } from "vitest";
import { runCli, shouldAttachRunObserver } from "./index.js";

describe("CLI parsing", () => {
  it("prints help for the help command", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli(["help"]);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("polish project add");
    expect(output).toContain("polish apply");
    expect(output).toContain("polish watch");
    write.mockRestore();
  });

  it("rejects unknown commands", async () => {
    await expect(runCli(["not-a-command"])).rejects.toThrow(/unknown command/);
  });

  it("rejects project without add subcommand", async () => {
    await expect(runCli(["project"])).rejects.toThrow(/project add/);
  });

  it("rejects invalid runtime mode before RPC", async () => {
    await expect(runCli(["run", ".", "--runtime", "maybe"])).rejects.toThrow(/runtime must be one of/);
  });

  it("rejects apply without run id", async () => {
    await expect(runCli(["apply"])).rejects.toThrow(/run id is required/);
  });

  it("rejects answer without text", async () => {
    await expect(runCli(["answer", "run_test"])).rejects.toThrow(/answer is required/);
  });

  it("attaches the observer only for interactive non-detached run", () => {
    expect(shouldAttachRunObserver({ detach: false, json: false, stdoutIsTTY: true })).toBe(true);
    expect(shouldAttachRunObserver({ detach: true, json: false, stdoutIsTTY: true })).toBe(false);
    expect(shouldAttachRunObserver({ detach: false, json: true, stdoutIsTTY: true })).toBe(false);
    expect(shouldAttachRunObserver({ detach: false, json: false, stdoutIsTTY: false })).toBe(false);
  });
});

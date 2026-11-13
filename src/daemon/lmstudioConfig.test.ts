import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretStore } from "../broker/secrets.js";
import { loadPolishConfig } from "./configLoad.js";
import { loadConfiguredProviders } from "./composition.js";

describe("lmstudio provider config", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is loaded without any secret and keeps its local settings", () => {
    const home = mkdtempSync(join(tmpdir(), "polish-lmstudio-"));
    dirs.push(home);
    writeFileSync(
      join(home, "polish.toml"),
      `
[[providers]]
id = "local"
kind = "lmstudio"
timeoutMs = 1800000
contextLength = 65536

[[providers]]
id = "openrouter"
kind = "openrouter"
apiKeyEnv = "OPENROUTER_API_KEY"
`,
    );
    const config = loadPolishConfig(home);
    expect(config.providers[0]).toMatchObject({ kind: "lmstudio", timeoutMs: 1_800_000, contextLength: 65_536, enabled: true });
    const providers = loadConfiguredProviders(config, SecretStore.fromValues({}), home);
    expect(providers.map((p) => `${p.id}:${p.kind}`)).toEqual(["local:lmstudio"]);
    expect(providers[0]?.concurrency).toBe(1);
  });
});

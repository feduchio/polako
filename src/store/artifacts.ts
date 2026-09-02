import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef } from "../domain/common.js";
import { sha256Hex } from "../shared/hash.js";
import { PolishError } from "../shared/errors.js";
import type { Db } from "./db.js";

/**
 * Content-addressed artifact store: bytes on disk under `<root>/<sha[0:2]>/<sha>`,
 * metadata in the `artifacts` table. Idempotent: putting the same bytes twice is a no-op.
 */
export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly root: string,
  ) {
    mkdirSync(root, { recursive: true });
  }

  put(data: string | Uint8Array, kind: string, label?: string, now: number = Date.now()): ArtifactRef {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const sha256 = sha256Hex(bytes);
    const path = this.pathFor(sha256);
    if (!existsSync(path)) {
      mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    this.db
      .prepare("INSERT OR IGNORE INTO artifacts (sha256, kind, bytes, label, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256, kind, bytes.byteLength, label ?? null, now);
    const ref: ArtifactRef = { sha256, kind, bytes: bytes.byteLength };
    if (label !== undefined) ref.label = label;
    return ref;
  }

  has(sha256: string): boolean {
    return existsSync(this.pathFor(sha256));
  }

  getBytes(sha256: string): Uint8Array {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) throw new PolishError("NOT_FOUND", `artifact ${sha256} not found`);
    const bytes = readFileSync(path);
    if (sha256Hex(bytes) !== sha256) {
      throw new PolishError("IO_ERROR", `artifact ${sha256} is corrupted on disk`, { path });
    }
    return bytes;
  }

  getText(sha256: string): string {
    return Buffer.from(this.getBytes(sha256)).toString("utf8");
  }

  meta(sha256: string): ArtifactRef | null {
    const row = this.db.prepare("SELECT sha256, kind, bytes, label FROM artifacts WHERE sha256 = ?").get(sha256) as
      | { sha256: string; kind: string; bytes: number; label: string | null }
      | undefined;
    if (!row) return null;
    const ref: ArtifactRef = { sha256: row.sha256, kind: row.kind, bytes: row.bytes };
    if (row.label !== null) ref.label = row.label;
    return ref;
  }

  pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new PolishError("INVARIANT_VIOLATION", "invalid sha256", { sha256 });
    return join(this.root, sha256.slice(0, 2), sha256);
  }
}

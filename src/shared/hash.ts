import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Hex(readFileSync(path));
}

/** Deterministic JSON serialization (sorted keys) for hashing structured data. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

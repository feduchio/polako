import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += ALPHABET.charAt(b % 32);
  return out;
}

const MAX_TIME = 32 ** 10 - 1;
const PREFIX_RE = /^[a-z]+$/;

/**
 * Time-sortable opaque identifier: `<prefix>_` + 10 chars of base32 timestamp + 12 random chars.
 * Sorting ids lexicographically sorts by creation time (ms resolution). Prefix must be lowercase
 * letters; timestamps are clamped to the encodable range so the output always matches `IdSchema`.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  if (!PREFIX_RE.test(prefix)) throw new TypeError(`id prefix must match ${PREFIX_RE.source}, got "${prefix}"`);
  const t = Number.isFinite(now) ? Math.min(MAX_TIME, Math.max(0, Math.floor(now))) : 0;
  return `${prefix}_${encodeTime(t)}${encodeRandom(randomBytes(12))}`;
}

export type IdPrefix =
  | "run"
  | "msn"
  | "mint"
  | "interp"
  | "task"
  | "cand"
  | "cp"
  | "find"
  | "fval"
  | "fact"
  | "job"
  | "evt"
  | "art"
  | "acc"
  | "corp"
  | "waiv"
  | "base"
  | "cr"
  | "call"
  | "mobs"
  | "rte";

export function id(prefix: IdPrefix, now?: number): string {
  return newId(prefix, now);
}

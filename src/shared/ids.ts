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

/**
 * Time-sortable opaque identifier: 10 chars of base32 timestamp + 12 random chars.
 * Sorting ids lexicographically sorts by creation time (ms resolution).
 */
export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${encodeRandom(randomBytes(12))}`;
}

export type IdPrefix =
  | "run"
  | "msn"
  | "mint"
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
  | "base"
  | "cr"
  | "call";

export function id(prefix: IdPrefix, now?: number): string {
  return newId(prefix, now);
}

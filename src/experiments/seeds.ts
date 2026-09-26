/**
 * Small correct modules for paired fixtures. Each has a weak test, kept in the fixture, that passes
 * on the correct code and on the mutants chosen from it, and an oracle, held outside the fixture,
 * that tells them apart. The weak test is what a run's gates see; the oracle is what the experiment
 * judges the run's final code by.
 */
export interface Seed {
  id: string;
  /** Module file under `src/`. */
  module: string;
  source: string;
  weakTest: string;
  oracleTest: string;
  /** The behavior a mission asks for, stated so it holds for the correct code. */
  behavior: string;
}

const header = (module: string, names: string) =>
  `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { ${names} } from "../src/${module}";\n`;

export const SEEDS: readonly Seed[] = [
  {
    id: "clamp",
    module: "clamp.mjs",
    source: "export function clamp(n, lo, hi) {\n  return Math.min(Math.max(n, lo), hi);\n}\n",
    weakTest: `${header("clamp.mjs", "clamp")}test("clamp of a one-point range", () => { assert.equal(clamp(3, 3, 3), 3); });\n`,
    oracleTest: `${header("clamp.mjs", "clamp")}test("clamp bounds", () => {\n  assert.equal(clamp(-1, 0, 10), 0);\n  assert.equal(clamp(11, 0, 10), 10);\n  assert.equal(clamp(0, 0, 10), 0);\n  assert.equal(clamp(10, 0, 10), 10);\n});\n`,
    behavior: "clamp(n, lo, hi) returns n limited to the inclusive range lo..hi",
  },
  {
    id: "leap",
    module: "leap.mjs",
    source: "export function isLeapYear(year) {\n  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;\n}\n",
    weakTest: `${header("leap.mjs", "isLeapYear")}test("2024 is a leap year", () => { assert.equal(isLeapYear(2024), true); });\n`,
    oracleTest: `${header("leap.mjs", "isLeapYear")}test("leap years", () => {\n  assert.equal(isLeapYear(1900), false);\n  assert.equal(isLeapYear(2000), true);\n  assert.equal(isLeapYear(2023), false);\n  assert.equal(isLeapYear(2024), true);\n});\n`,
    behavior: "isLeapYear(year) follows the Gregorian rule: divisible by 4, except centuries not divisible by 400",
  },
  {
    id: "median",
    module: "median.mjs",
    source: "export function median(values) {\n  const sorted = [...values].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  if (sorted.length % 2 === 1) return sorted[mid];\n  return (sorted[mid - 1] + sorted[mid]) / 2;\n}\n",
    weakTest: `${header("median.mjs", "median")}test("median of one value", () => { assert.equal(median([5]), 5); });\n`,
    oracleTest: `${header("median.mjs", "median")}test("median", () => {\n  assert.equal(median([3, 1, 2]), 2);\n  assert.equal(median([1, 2, 3, 4]), 2.5);\n  assert.equal(median([10, 2, 38, 23, 38, 23, 21]), 23);\n});\n`,
    behavior: "median(values) returns the middle value of the sorted numbers, or the mean of the two middle values for an even count",
  },
  {
    id: "chunk",
    module: "chunk.mjs",
    source: "export function chunk(items, size) {\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}\n",
    weakTest: `${header("chunk.mjs", "chunk")}test("chunk of nothing", () => { assert.deepEqual(chunk([], 2), []); });\n`,
    oracleTest: `${header("chunk.mjs", "chunk")}test("chunk", () => {\n  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);\n  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);\n  assert.deepEqual(chunk([1], 3), [[1]]);\n});\n`,
    behavior: "chunk(items, size) splits items into consecutive arrays of at most size elements, in order",
  },
  {
    id: "range",
    module: "range.mjs",
    source: "export function range(start, end) {\n  const out = [];\n  for (let i = start; i < end; i += 1) out.push(i);\n  return out;\n}\n",
    weakTest: `${header("range.mjs", "range")}test("empty range", () => { assert.deepEqual(range(3, 3), []); });\n`,
    oracleTest: `${header("range.mjs", "range")}test("range", () => {\n  assert.deepEqual(range(1, 4), [1, 2, 3]);\n  assert.deepEqual(range(0, 1), [0]);\n  assert.deepEqual(range(5, 2), []);\n});\n`,
    behavior: "range(start, end) returns the integers from start up to but not including end",
  },
  {
    id: "discount",
    module: "discount.mjs",
    source: "export function applyDiscount(price, percent) {\n  if (percent <= 0) return price;\n  if (percent >= 100) return 0;\n  return Math.round(price * (100 - percent)) / 100;\n}\n",
    weakTest: `${header("discount.mjs", "applyDiscount")}test("no discount", () => { assert.equal(applyDiscount(40, -5), 40); });\n`,
    oracleTest: `${header("discount.mjs", "applyDiscount")}test("discounts", () => {\n  assert.equal(applyDiscount(100, 25), 75);\n  assert.equal(applyDiscount(80, 100), 0);\n  assert.equal(applyDiscount(50, 0), 50);\n  assert.equal(applyDiscount(19.99, 10), 17.99);\n  assert.equal(applyDiscount(10, 99), 0.1);\n});\n`,
    behavior: "applyDiscount(price, percent) returns price reduced by percent, rounded to cents; at most 100% off and never a negative discount",
  },
  {
    id: "fizz",
    module: "fizz.mjs",
    source: "export function fizz(n) {\n  if (n % 15 === 0) return \"FizzBuzz\";\n  if (n % 3 === 0) return \"Fizz\";\n  if (n % 5 === 0) return \"Buzz\";\n  return String(n);\n}\n",
    weakTest: `${header("fizz.mjs", "fizz")}test("plain number", () => { assert.equal(fizz(1), "1"); });\n`,
    oracleTest: `${header("fizz.mjs", "fizz")}test("fizzbuzz", () => {\n  assert.equal(fizz(3), "Fizz");\n  assert.equal(fizz(5), "Buzz");\n  assert.equal(fizz(15), "FizzBuzz");\n  assert.equal(fizz(7), "7");\n});\n`,
    behavior: "fizz(n) returns FizzBuzz for multiples of 15, Fizz for multiples of 3, Buzz for multiples of 5, otherwise the number",
  },
  {
    id: "search",
    module: "search.mjs",
    source: "export function indexOfSorted(values, target) {\n  let lo = 0;\n  let hi = values.length - 1;\n  while (lo <= hi) {\n    const mid = Math.floor((lo + hi) / 2);\n    if (values[mid] === target) return mid;\n    if (values[mid] < target) lo = mid + 1;\n    else hi = mid - 1;\n  }\n  return -1;\n}\n",
    weakTest: `${header("search.mjs", "indexOfSorted")}test("nothing to find", () => { assert.equal(indexOfSorted([], 1), -1); });\n`,
    oracleTest: `${header("search.mjs", "indexOfSorted")}test("binary search", () => {\n  assert.equal(indexOfSorted([1, 3, 5, 7, 9], 7), 3);\n  assert.equal(indexOfSorted([1, 3, 5, 7, 9], 1), 0);\n  assert.equal(indexOfSorted([1, 3, 5, 7, 9], 9), 4);\n  assert.equal(indexOfSorted([1, 3, 5, 7, 9], 4), -1);\n});\n`,
    behavior: "indexOfSorted(values, target) returns the index of target in the ascending array values, or -1 when absent",
  },
  {
    id: "vowels",
    module: "vowels.mjs",
    source: "export function countVowels(text) {\n  let count = 0;\n  for (const ch of text.toLowerCase()) if (\"aeiou\".includes(ch)) count += 1;\n  return count;\n}\n",
    weakTest: `${header("vowels.mjs", "countVowels")}test("no text", () => { assert.equal(countVowels(""), 0); });\n`,
    oracleTest: `${header("vowels.mjs", "countVowels")}test("vowels", () => {\n  assert.equal(countVowels("Hello"), 2);\n  assert.equal(countVowels("AEIOU xyz"), 5);\n});\n`,
    behavior: "countVowels(text) counts the letters a, e, i, o, u in text, case-insensitively",
  },
  {
    id: "palindrome",
    module: "palindrome.mjs",
    source: "export function isPalindrome(text) {\n  const t = text.toLowerCase().replace(/[^a-z0-9]/g, \"\");\n  for (let i = 0, j = t.length - 1; i < j; i += 1, j -= 1) {\n    if (t[i] !== t[j]) return false;\n  }\n  return true;\n}\n",
    weakTest: `${header("palindrome.mjs", "isPalindrome")}test("one letter", () => { assert.equal(isPalindrome("a"), true); });\n`,
    oracleTest: `${header("palindrome.mjs", "isPalindrome")}test("palindromes", () => {\n  assert.equal(isPalindrome("Racecar"), true);\n  assert.equal(isPalindrome("ab"), false);\n  assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true);\n  assert.equal(isPalindrome("abca"), false);\n});\n`,
    behavior: "isPalindrome(text) says whether text reads the same backwards, ignoring case and anything but letters and digits",
  },
];

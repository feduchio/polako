import { describe, expect, it } from "vitest";
import { parseTestReport, processEnd } from "./parsers.js";

const NODE_ASSERTION = `✖ adds (0.5385ms)
✔ passes (0.078083ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 33.5265

✖ failing tests:

test at tests/add.test.mjs:2:1
✖ adds (0.5385ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  -1 !== 5
  
      at TestContext.<anonymous> (file:///private/tmp/p/tests/add.test.mjs:2:29)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1397:25) {
    generatedMessage: true,
    code: 'ERR_ASSERTION'
  }
`;

const NODE_JEST_STYLE_STDOUT = `✖ tests/neg.test.mjs (22.849625ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 25.670417

✖ failing tests:

test at tests/neg.test.mjs:1:1
✖ tests/neg.test.mjs (22.849625ms)
  'test failed'
`;

const NODE_JEST_STYLE_STDERR = `file:///private/tmp/p/tests/neg.test.mjs:2
describe("add", () => { test("adds", () => { expect(add(2,3)).toBe(5); }); });
^

ReferenceError: describe is not defined
    at file:///private/tmp/p/tests/neg.test.mjs:2:1
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)

Node.js v24.20.0
`;

const NODE_MISSING_MODULE = `node:internal/modules/esm/resolve:272
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/tmp/p/nope.mjs' imported from /private/tmp/p/tests/missing.test.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:272:11) {
  code: 'ERR_MODULE_NOT_FOUND'
}

Node.js v24.20.0
✖ tests/missing.test.mjs (33.935708ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1

✖ failing tests:

test at tests/missing.test.mjs:1:1
✖ tests/missing.test.mjs (33.935708ms)
  'test failed'
`;

const NODE_PRODUCT_ERROR = `✖ boom (0.290125ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1

✖ failing tests:

test at tests/boom.test.mjs:2:1
✖ boom (0.290125ms)
  TypeError: x.y is not a function
      at boom (file:///private/tmp/p/src/add.mjs:2:35)
      at TestContext.<anonymous> (file:///private/tmp/p/tests/boom.test.mjs:2:22)
      at Test.runInAsyncScope (node:async_hooks:227:14)
`;

const VITEST = `
 RUN  v4.1.11 /private/tmp/p

 ❯ b.test.mjs (0 test)
 ❯ a.test.mjs (3 tests | 2 failed) 3ms
   × adds 3ms
   × boom 0ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  b.test.mjs [ b.test.mjs ]
ReferenceError: foo is not defined
 ❯ b.test.mjs:2:1
      1| import { add } from "./add.mjs";
      2| foo();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  a.test.mjs > adds
AssertionError: expected -1 to be 5 // Object.is equality

 ❯ a.test.mjs:2:40

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  a.test.mjs > boom
TypeError: x.y is not a function
 ❯ boom add.mjs:2:35
 ❯ a.test.mjs:3:22

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯

 Test Files  2 failed (2)
      Tests  2 failed | 1 passed (3)
`;

const JEST = `FAIL tests/add.test.js
  ● add › adds

    expect(received).toBe(expected) // Object.is equality

    Expected: 5
    Received: -1

      at Object.toBe (tests/add.test.js:5:20)

FAIL tests/broken.test.js
  ● Test suite failed to run

    Cannot find module './nope' from 'tests/broken.test.js'

      at Resolver._throwModNotFoundError (node_modules/jest-resolve/build/resolver.js:427:11)

Test Suites: 2 failed, 2 total
Tests:       1 failed, 1 total
`;

describe("parseTestReport", () => {
  it("classifies a node:test assertion with its location and top frame", () => {
    const report = parseTestReport("node-test", NODE_ASSERTION, "");
    expect(report.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(report.failures).toEqual([{
      identity: "tests/add.test.mjs:2:1 > adds",
      kind: "assertion",
      message: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
      location: "/private/tmp/p/tests/add.test.mjs:2:29",
    }]);
  });

  it("finds the ReferenceError behind a node:test file that failed to load, on stderr", () => {
    const report = parseTestReport("node-test", NODE_JEST_STYLE_STDOUT, NODE_JEST_STYLE_STDERR);
    expect(report.failures).toEqual([{
      identity: "tests/neg.test.mjs",
      kind: "reference_error",
      message: "ReferenceError: describe is not defined",
      location: "/private/tmp/p/tests/neg.test.mjs:2:1",
    }]);
  });

  it("names a missing module as such", () => {
    const [failure] = parseTestReport("node-test", NODE_MISSING_MODULE, "").failures;
    expect(failure?.identity).toBe("tests/missing.test.mjs");
    expect(failure?.kind).toBe("module_not_found");
  });

  it("keeps an error thrown by product code as an error whose top frame is the product", () => {
    const [failure] = parseTestReport("node-test", NODE_PRODUCT_ERROR, "").failures;
    expect(failure).toMatchObject({ kind: "error", message: "TypeError: x.y is not a function", location: "/private/tmp/p/src/add.mjs:2:35" });
  });

  it("reads vitest suite and test failures", () => {
    const report = parseTestReport("vitest", VITEST, "");
    expect(report.failures.map(({ identity, kind, location }) => ({ identity, kind, location }))).toEqual([
      { identity: "b.test.mjs", kind: "reference_error", location: "b.test.mjs:2:1" },
      { identity: "a.test.mjs > adds", kind: "assertion", location: "a.test.mjs:2:40" },
      { identity: "a.test.mjs > boom", kind: "error", location: "add.mjs:2:35" },
    ]);
  });

  it("reads jest test and suite failures", () => {
    const report = parseTestReport("jest", JEST, "");
    expect(report.failures.map(({ identity, kind, location }) => ({ identity, kind, location }))).toEqual([
      { identity: "tests/add.test.js > add › adds", kind: "assertion", location: "tests/add.test.js:5:20" },
      { identity: "tests/broken.test.js", kind: "module_not_found", location: null },
    ]);
  });

  it("reports no failures for a passing run", () => {
    expect(parseTestReport("node-test", "✔ fine (0.1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n", "").failures).toEqual([]);
  });
});

describe("processEnd", () => {
  const base = { exitCode: 1, signal: null, timedOut: false, aborted: false };
  it("separates a killed, timed-out or aborted process from one that exited", () => {
    expect(processEnd(base)).toBe("exited");
    expect(processEnd({ ...base, exitCode: null, signal: "SIGKILL" })).toBe("killed");
    expect(processEnd({ ...base, exitCode: null })).toBe("killed");
    expect(processEnd({ ...base, timedOut: true, exitCode: null, signal: "SIGTERM" })).toBe("timeout");
    expect(processEnd({ ...base, aborted: true })).toBe("aborted");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEntry } from "../src/cli/invocation.js";

test("classifyEntry: a .ts entry is a dev (tsx) checkout, never installed", () => {
  assert.deepEqual(classifyEntry("/repo/src/cli/index.ts"), { isDev: true, installed: false });
});

test("classifyEntry: a compiled entry inside node_modules is installed", () => {
  assert.deepEqual(
    classifyEntry("/home/me/.npm-global/lib/node_modules/@davesheffer/hunch/dist/cli/index.js"),
    { isDev: false, installed: true },
  );
});

test("classifyEntry: a compiled entry OUTSIDE node_modules (built dist run, npm link) is neither dev nor installed — this is the case round 2's isDev-only check missed, since 'npm install -g' is equally wrong advice here", () => {
  assert.deepEqual(classifyEntry("/repo/dist/cli/index.js"), { isDev: false, installed: false });
});

test("classifyEntry: a Windows backslash path inside node_modules is still detected as installed", () => {
  assert.deepEqual(
    classifyEntry("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@davesheffer\\hunch\\dist\\cli\\index.js"),
    { isDev: false, installed: true },
  );
});

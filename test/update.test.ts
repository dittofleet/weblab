import assert from "node:assert/strict";
import { test } from "node:test";
import { newer } from "../src/update.ts";

test("a release is newer by its numbers, not its text", () => {
  assert.equal(newer("0.10.0", "0.9.1"), true);
  assert.equal(newer("0.1.1", "0.1.0"), true);
  assert.equal(newer("1.0.0", "0.9.9"), true);
  assert.equal(newer("0.1.0", "0.1.0"), false);
  assert.equal(newer("0.1.0", "0.2.0"), false);
});

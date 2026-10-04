// The code's own assertion fails, with a diff under its first line.
import assert from "node:assert/strict";

export default async () => {
  assert.deepEqual({ count: 1 }, { count: 2 });
};

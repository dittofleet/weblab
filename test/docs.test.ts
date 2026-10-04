// The docs name what the code has: every step, and every argument of
// the tools, so neither can change without the other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { builtinActions } from "../src/steps/index.ts";
import { SESSION_KEYS } from "../src/steps/sessions.ts";

const page = (name: string) => readFileSync(join(import.meta.dirname, "..", "docs", `${name}.md`), "utf8");
// The first cell of a table row: | `name` | ...
const rows = (text: string) => new Set([...text.matchAll(/^\| `([\w-]+)`/gm)].map((match) => match[1]));

test("docs/steps.md has a row for every step, and for nothing that isn't one", () => {
  const steps = page("steps");
  const documented = rows(steps);
  for (const step of [...Object.keys(builtinActions), "include"]) assert.ok(documented.has(step), `docs/steps.md has no row for the ${step} step`);
  // A row in a section of steps names a step: one that no longer exists is stale.
  const sections = steps.slice(steps.indexOf("## Getting around"), steps.indexOf("## Reusing steps"));
  for (const [, heading, body] of sections.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |\Z)/gm)) {
    const table = (body as string).split(/^### /m)[0] as string;
    for (const name of rows(table)) assert.ok(name in builtinActions, `docs/steps.md lists "${name}" under ${heading}, which is not a step`);
  }
});

test("docs/tools.md has a row for every argument of new and run", () => {
  const documented = rows(page("tools"));
  for (const key of [...SESSION_KEYS, "session", "steps", "file", "params", "wait"]) assert.ok(documented.has(key), `docs/tools.md has no row for ${key}`);
});

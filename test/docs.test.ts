// The docs name what the code has: every step, and every argument of
// the tools, so neither can change without the other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DOCS, docSection } from "../src/docs.ts";
import { builtinActions, STEP_NAMES } from "../src/steps/index.ts";
import { SESSION_KEYS } from "../src/steps/sessions.ts";

const page = (name: string) => readFileSync(join(import.meta.dirname, "..", "docs", `${name}.md`), "utf8");
// The first cell of a table row: | `name` | ...
const rows = (text: string) => new Set([...text.matchAll(/^\| `([\w-]+)`/gm)].map((match) => match[1]));

test("docs/steps.md has a row for every step, and for nothing that isn't one", () => {
  const steps = page("steps");
  const documented = rows(steps);
  for (const step of STEP_NAMES) assert.ok(documented.has(step), `docs/steps.md has no row for the ${step} step`);
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

test("a step's name reads its section, with only its own row of the table", () => {
  for (const step of STEP_NAMES) {
    const section = docSection(step);
    assert.match(section, /^weblab:\/\/docs\/steps#/, `docs section "${step}" isn't on the steps page`);
    const listed = rows(section);
    assert.ok(listed.has(step), `docs section "${step}" has no row for it`);
    for (const other of STEP_NAMES) if (other !== step) assert.ok(!listed.has(other), `docs section "${step}" has a row for ${other}`);
  }
  assert.match(docSection("colorscheme"), /^\| `colorScheme` \|/m, "a step's name is matched in any case");
  // The parts of a section under headings of their own are named, not included.
  const capturing = docSection("shot");
  assert.match(capturing, /^weblab:\/\/docs\/steps#reading-and-capturing\n/);
  assert.match(capturing, /\nSections inside this one: Holding a shot to one taken before; The real screen; Recording a video$/);
  assert.doesNotMatch(capturing, /^### /m);
});

test("a heading reads by its title or its anchor, and a step's name comes before it", () => {
  for (const asked of ["Refs", "refs", "#refs", "steps#refs", "steps.md#refs", "weblab://docs/steps#refs"]) assert.match(docSection(asked), /^weblab:\/\/docs\/steps#refs\n\n### Refs\n/, asked);
  assert.match(docSection("A `new` step, and what it inherits"), /^weblab:\/\/docs\/sessions#a-new-step-and-what-it-inherits\n/);
  // A link within the page says which page it is on.
  assert.match(docSection("Targets"), /\[Refs\]\(weblab:\/\/docs\/steps#refs\)/);
  const step = docSection("new");
  assert.match(step, /^weblab:\/\/docs\/steps#more-than-one-session\n/);
  assert.match(step, /\n\nAlso under that name: weblab:\/\/docs\/tools#new$/);
  assert.match(docSection("new", "tools"), /^weblab:\/\/docs\/tools#new\n\n## new\n/);
  assert.throws(() => docSection("clik"), /no section "clik" in the docs \(did you mean "click"\?\)/);
  assert.throws(() => docSection("refs", "tools"), /no section "refs" in the tools page/);
});

test("every link to a part of a page names a heading there", () => {
  for (const page of DOCS) {
    for (const [, target = page.name, anchor] of page.text.matchAll(/\]\((?:(\w+)\.md)?#([\w-]+)\)/g)) {
      assert.match(docSection(`${target}#${anchor}`), new RegExp(`^weblab://docs/${target}#${anchor}\n`), `${page.name}.md links to ${target}#${anchor}`);
    }
  }
});

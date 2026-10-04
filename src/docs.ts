// The reference pages, carried inside weblab so an agent can read them
// where it uses the tools: as MCP resources, and through the docs tool,
// a whole page or one section of one at a time.
import code from "../docs/code.md" with { type: "text" };
import recipes from "../docs/recipes.md" with { type: "text" };
import sessions from "../docs/sessions.md" with { type: "text" };
import steps from "../docs/steps.md" with { type: "text" };
import tools from "../docs/tools.md" with { type: "text" };
import { UsageError } from "./errors.ts";
import { nearest } from "./util.ts";

export type DocPage = { name: string; about: string; text: string };

export const DOCS: DocPage[] = [
  { name: "tools", about: "Every argument of new, run, end, list and docs, what each reply holds, how an address is resolved, when a server is started and stopped, attach, long runs, and where files go.", text: tools },
  { name: "steps", about: "Every step and its options, how elements are targeted, refs, expect, include and placeholders.", text: steps },
  { name: "sessions", about: "More than one session: two users, copies of an app on several ports, running browsers and Electron apps, other engines, saved sign-ins.", text: sessions },
  { name: "code", about: "The js, css, playwright and cdp steps, and step files written as code.", text: code },
  { name: "recipes", about: "Short answers to common tasks, as the steps to run: fake an API, steady screenshots, native menus, record a demo, debug a failure.", text: recipes },
];

/** A page's address as a resource. */
export const docUri = (name: string) => `weblab://docs/${name}`;

// Links between pages, as they are written for a reader on disk, say where the page is here.
const linked = (text: string) => text.replace(/\]\((tools|steps|sessions|code|recipes)\.md(#[\w-]+)?\)/g, (_whole, name: string, anchor = "") => `](${docUri(name)}${anchor})`);

export const docText = (page: DocPage) => linked(page.text);

/** The pages there are, a line each. */
export const docIndex = () => DOCS.map((page) => `${page.name}: ${page.about}`).join("\n");

// ---- sections

/** A `##` or `###` heading and what follows it, up to the next heading of either. */
type Section = { page: DocPage; level: number; title: string; anchor: string; lines: string[]; inside: Section[] };

/** A heading's anchor, as GitHub makes it: what links to it say after the #. */
export const anchorOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

function sectionsOf(page: DocPage): Section[] {
  const found: Section[] = [];
  let current: Section | undefined;
  let fenced = false;
  for (const line of page.text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    // A # inside a code block is a shell comment, not a heading.
    const heading = fenced ? null : /^(#{2,3}) (.+)$/.exec(line);
    if (heading === null) {
      current?.lines.push(line);
      continue;
    }
    const level = (heading[1] as string).length;
    const title = heading[2] as string;
    current = { page, level, title, anchor: anchorOf(title), lines: [line], inside: [] };
    if (level === 3) found.findLast((one) => one.level === 2)?.inside.push(current);
    found.push(current);
  }
  return found;
}

const SECTIONS = DOCS.flatMap(sectionsOf);

// A step's row in a table of steps: | `name` | ...
const TABLE_OF_STEPS = /^\| Step \|/;
const rowName = (line: string) => /^\| `([\w-]+)` \|/.exec(line)?.[1];

/** Each line's step, for the rows of a table of steps. */
function stepRows(lines: string[]): (string | undefined)[] {
  let inTable = false;
  return lines.map((line) => {
    if (TABLE_OF_STEPS.test(line)) inTable = true;
    else if (!line.startsWith("|")) inTable = false;
    return inTable ? rowName(line) : undefined;
  });
}

/** The steps a section's table of steps has a row for. */
const stepsIn = (section: Section) => stepRows(section.lines).filter((name) => name !== undefined);

/** The section's lines, keeping only the given step's row in its table of steps. */
function onlyStep(lines: string[], step: string): string[] {
  const names = stepRows(lines);
  return lines.filter((_line, index) => names[index] === undefined || names[index].toLowerCase() === step);
}

const sectionUri = (section: Section) => `${docUri(section.page.name)}#${section.anchor}`;

function render(section: Section, step?: string): string {
  const lines = step === undefined ? section.lines : onlyStep(section.lines, step);
  // A link within the page needs its page, now that it is read apart from it.
  const text = linked(lines.join("\n").trim()).replace(/\]\(#([\w-]+)\)/g, `](${docUri(section.page.name)}#$1)`);
  const inside = section.inside.length === 0 ? [] : ["", `Sections inside this one: ${section.inside.map((one) => one.title).join("; ")}`];
  return [sectionUri(section), "", text, ...inside].join("\n");
}

/**
 * One section of the docs: a step by its name (its section, with only
 * its row of the table), or a heading by its title or anchor, as in
 * "Refs", "refs", "steps#refs" or "weblab://docs/steps#refs".
 */
export function docSection(asked: string, pageName?: string): string {
  let wanted = asked.trim().replace(/^weblab:\/\/docs\//, "");
  let pages = pageName === undefined ? DOCS.map((page) => page.name) : [pageName];
  const hash = wanted.indexOf("#");
  if (hash !== -1) {
    const named = wanted.slice(0, hash).replace(/\.md$/, "");
    if (named !== "") pages = [named];
    wanted = wanted.slice(hash + 1);
  }
  const among = SECTIONS.filter((section) => pages.includes(section.page.name));
  const step = wanted.toLowerCase();
  const forStep = among.filter((section) => stepsIn(section).some((name) => name.toLowerCase() === step));
  const forHeading = among.filter((section) => section.anchor === anchorOf(wanted) && !forStep.includes(section));
  const [first, ...others] = [...forStep, ...forHeading];
  if (first === undefined) {
    const guess = nearest(wanted, among.flatMap((section) => [section.title, ...stepsIn(section)]));
    const where = pages.length === 1 ? `the ${pages[0]} page` : "the docs";
    throw new UsageError(`no section "${asked}" in ${where}${guess === undefined ? "" : ` (did you mean "${guess}"?)`}; docs with no arguments lists every page's sections`);
  }
  const text = render(first, forStep.includes(first) ? step : undefined);
  return others.length === 0 ? text : `${text}\n\nAlso under that name: ${others.map(sectionUri).join(", ")}`;
}

/** The pages, a line each, with the sections each one has. */
export const docContents = () =>
  DOCS.map((page) => {
    const titles = SECTIONS.filter((section) => section.page === page).map((section) => section.title);
    return `${page.name}: ${page.about}\n  sections: ${titles.join("; ")}`;
  }).join("\n");

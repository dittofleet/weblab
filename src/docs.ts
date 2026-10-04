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
// So does a link within a page, given the page, for a part of it read apart from the rest.
const LINK = new RegExp(`\\]\\((?:(${DOCS.map((page) => page.name).join("|")})\\.md)?(#[\\w-]+)?\\)`, "g");
const linked = (text: string, within?: DocPage) =>
  text.replace(LINK, (whole, name: string | undefined, anchor = "") => {
    const page = name ?? (anchor === "" ? undefined : within?.name);
    return page === undefined ? whole : `](${docUri(page)}${anchor})`;
  });

export const docText = (page: DocPage) => linked(page.text);

const pageLine = (page: DocPage) => `${page.name}: ${page.about}`;

/** The pages there are, a line each. */
export const docIndex = () => DOCS.map(pageLine).join("\n");

// ---- sections

/**
 * A `##` or `###` heading and what follows it, up to the next heading of
 * either, with the step each line's row names in a table of steps.
 */
type Section = { page: DocPage; title: string; anchor: string; lines: string[]; rows: (string | undefined)[]; inside: Section[]; steps: string[] };

/** A heading's anchor, as GitHub makes it: what links to it say after the #. */
const anchorOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

// A step's row in a table of steps: | `name` | ...
const TABLE_OF_STEPS = /^\| Step \|/;
const rowName = (line: string) => /^\| `([\w-]+)` \|/.exec(line)?.[1];

function sectionsOf(page: DocPage): Section[] {
  const found: Section[] = [];
  let current: Section | undefined;
  let parent: Section | undefined;
  let fenced = false;
  let inTable = false;
  for (const line of page.text.split(/\r?\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    // A # inside a code block is a shell comment, not a heading, and a table there is an example.
    const heading = fenced ? null : /^(#{2,3}) (.+)$/.exec(line);
    if (heading !== null) {
      const title = heading[2] as string;
      current = { page, title, anchor: anchorOf(title), lines: [], rows: [], inside: [], steps: [] };
      if (heading[1] === "##") parent = current;
      else parent?.inside.push(current);
      found.push(current);
    }
    if (TABLE_OF_STEPS.test(line)) inTable = !fenced;
    else if (!line.startsWith("|")) inTable = false;
    const step = inTable ? rowName(line) : undefined;
    current?.lines.push(line);
    current?.rows.push(step);
    if (step !== undefined) current?.steps.push(step);
  }
  return found;
}

const SECTIONS = DOCS.flatMap(sectionsOf);

const sectionUri = (section: Section) => `${docUri(section.page.name)}#${section.anchor}`;

function render(section: Section, step?: string): string {
  // A step's section keeps only that step's row of its table of steps.
  const lines = step === undefined ? section.lines : section.lines.filter((_line, index) => (section.rows[index]?.toLowerCase() ?? step) === step);
  const inside = section.inside.length === 0 ? [] : ["", `Sections inside this one: ${section.inside.map((one) => one.title).join("; ")}`];
  return [sectionUri(section), "", linked(lines.join("\n").trim(), section.page), ...inside].join("\n");
}

/**
 * One section of the docs: a step by its name (its section, with only
 * its row of the table), or a heading by its title or anchor, as in
 * "Refs", "refs", "steps#refs" or "weblab://docs/steps#refs".
 */
export function docSection(asked: string, pageName?: string): string {
  let wanted = asked
    .trim()
    .replace(/^`(.*)`$/, "$1")
    .replace(/^weblab:\/\/docs\//, "");
  let pages = pageName === undefined ? DOCS.map((page) => page.name) : [pageName];
  const hash = wanted.indexOf("#");
  if (hash !== -1) {
    const named = wanted.slice(0, hash).replace(/\.md$/, "");
    if (named !== "") pages = [named];
    wanted = wanted.slice(hash + 1);
  }
  if (wanted === "") throw new UsageError("section is empty: name a step or a heading, or leave section out for the pages and their sections");
  const among = SECTIONS.filter((section) => pages.includes(section.page.name));
  const step = wanted.toLowerCase();
  const anchor = anchorOf(wanted);
  // A step's name before a heading's, and each section once.
  const matches: { section: Section; step?: string }[] = [
    ...among.filter((section) => section.steps.some((name) => name.toLowerCase() === step)).map((section) => ({ section, step })),
    // A code step's own section on the code page is titled for it: "playwright: the whole Playwright API".
    ...among.filter((section) => section.anchor === anchor || section.title.toLowerCase().startsWith(`${step}:`)).map((section) => ({ section })),
  ].filter((match, index, all) => all.findIndex((other) => other.section === match.section) === index);
  const [first, ...others] = matches;
  if (first === undefined) {
    const guess = nearest(wanted, among.flatMap((section) => [section.title, ...section.steps]));
    const where = pages.length === 1 ? `the ${pages[0]} page` : "the docs";
    throw new UsageError(`no section "${asked}" in ${where}${guess === undefined ? "" : ` (did you mean "${guess}"?)`}. The docs tool with no arguments lists every page's sections.`);
  }
  const text = render(first.section, first.step);
  return others.length === 0 ? text : `${text}\n\nAlso under that name: ${others.map((other) => sectionUri(other.section)).join(", ")}`;
}

/** The pages, a line each, with the sections each one has. */
export const docContents = () =>
  DOCS.map((page) => `${pageLine(page)}\n  sections: ${SECTIONS.filter((section) => section.page === page).map((section) => section.title).join("; ")}`).join("\n");

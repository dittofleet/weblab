// The reference pages, carried inside weblab so an agent can read them
// where it uses the tools: as MCP resources, and through the docs tool.
import code from "../docs/code.md" with { type: "text" };
import recipes from "../docs/recipes.md" with { type: "text" };
import sessions from "../docs/sessions.md" with { type: "text" };
import steps from "../docs/steps.md" with { type: "text" };
import tools from "../docs/tools.md" with { type: "text" };

export type DocPage = { name: string; about: string; text: string };

export const DOCS: DocPage[] = [
  { name: "tools", about: "Every argument of new, run, end and list, what each reply holds, how an address is resolved, when a server is started and stopped, attach, long runs, and where files go.", text: tools },
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

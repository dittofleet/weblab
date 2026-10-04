// React: the app's components as React DevTools shows them, read and
// changed through what src/react/page.ts keeps in the page.
//   { "react": "tree" }                          the component tree, with ids (c12)
//   { "react": { "inspect": "CartItem" } }       props, hooks, context, owners, where in the source
//   { "react": "renders" }                       what rendered since the last time asked, and why
//   { "react": { "set": "Counter", "hook": 0, "value": 5 } }
//   { "react": { "suspend": "ProductList" } }    a Suspense boundary shows its fallback
//   { "react": { "error": "Checkout" } }         an error boundary shows its error state
// A component is named by its name (with nth), its id, or any element
// target, which means the component that rendered that element.
import type { Locator } from "playwright-core";
import { briefError } from "../errors.ts";
import { INSTALL, watchReact } from "../react/watch.ts";
import { placeText, type Made } from "../sources.ts";
import { nearest } from "../util.ts";
import type { Action, ActionContext } from "../types.ts";
import { bad, isObject } from "./args.ts";
import { locate, REF } from "./target.ts";

export const REACT_ACTIONS = ["tree", "inspect", "renders", "set", "suspend", "error"] as const;
type ReactAction = (typeof REACT_ACTIONS)[number];
// What each action takes beside the component it names, so an option
// given to the wrong one is refused rather than quietly ignored.
const OPTIONS: Record<ReactAction, string[]> = {
  tree: ["nth", "depth", "library"],
  inspect: ["nth", "library", "prop", "hook", "state"],
  renders: ["nth", "library", "keep"],
  set: ["nth", "library", "prop", "hook", "state", "value", "js"],
  suspend: ["nth", "library"],
  error: ["nth", "library"],
};
export const REACT_KEYS = [...REACT_ACTIONS, ...new Set(Object.values(OPTIONS).flat())];

const SHAPE = `"tree", "renders", or { tree | inspect | set | suspend | error: a component, ... }`;
// Lines a tree prints before it says how many more there are.
const TREE_LIMIT = 400;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// What the page threw, without what Playwright puts before it.
const thrown = (error: unknown) => briefError(error).replace(/^(?:[\w.]*evaluate: )?(?:Error: )?/, "");

// Each page `weblab.react` was put into, by which of its loads: a page
// loaded before the hook was there (an attached app) gets it once.
const installed = new WeakMap<object, number>();
async function ready(ctx: ActionContext): Promise<void> {
  // The pages this session loads from now on have the hook from the start, so a reload gives all of it.
  await watchReact(ctx.context);
  if (installed.get(ctx.page) === ctx.loads()) return;
  await ctx.page.evaluate(INSTALL);
  installed.set(ctx.page, ctx.loads());
}

/** What the page says of a call: its value, or that the step asked for what isn't there (with the names near it). */
type Answer<T> = { value: T } | { refused: string; names: string[] };

// Runs one of weblab.react's own calls in the page. A refusal is the step
// being written wrong, and anything the page throws is the step failing.
async function ask<T>(ctx: ActionContext, call: string, args: unknown[] = []): Promise<Answer<T>> {
  await ready(ctx);
  try {
    return (await ctx.page.evaluate(([call, args]) => (window as any).weblab.react._run(call, args), [call, args] as const)) as Answer<T>;
  } catch (error) {
    return ctx.fail(thrown(error));
  }
}
async function inPage<T>(ctx: ActionContext, call: string, args: unknown[] = []): Promise<T> {
  const answer = await ask<T>(ctx, call, args);
  return "refused" in answer ? ctx.usage(answer.refused) : answer.value;
}

/** The component a step means (by its id), the element that named it (when one did), and the library component inside it that rendered that element. */
type Meant = { id: string; element: Locator | null; via: { id: string; name: string; from: string | null } | null };

/** Which component a step means: by name (and nth), by id, or as whatever rendered an element. */
async function component(ctx: ActionContext, target: unknown, nth: number | undefined, library: boolean): Promise<Meant> {
  const byName = async (name: string, nth = 0): Promise<Meant> => {
    const answer = await ask<string>(ctx, "_resolve", [name, nth]);
    if ("refused" in answer) {
      const guess = nearest(name, answer.names);
      return ctx.usage(`${answer.refused}${guess !== undefined && guess !== name ? ` (did you mean ${guess}?)` : ""}`);
    }
    return { id: answer.value, element: null, via: null };
  };
  if (typeof target === "string" && !REF.test(target)) return byName(target, nth);
  if (isObject(target) && typeof target.component === "string") return byName(target.component, typeof target.nth === "number" ? target.nth : nth);
  if (typeof target !== "string" && !isObject(target)) return bad("react", `a component: its name, its id (c12), or an element target`);
  const element = locate(ctx, target, "react");
  await element.waitFor({ state: "attached", timeout: ctx.timeout });
  await ready(ctx);
  try {
    const found = await element.evaluate((node, library) => (window as any).weblab.react._resolveElement(node, library), library);
    return { ...found, element };
  } catch (error) {
    return ctx.fail(thrown(error));
  }
}

// ---- what each prints

type Inspected = {
  id: string;
  name: string;
  kind: string;
  key: string | null;
  props: [string, string][];
  state: [string, string][];
  hooks: { index: number; slot: number; kind: string; value?: string; deps?: string; state: boolean; path: string[]; count?: number }[];
  compiled: boolean;
  contexts: [string, string][];
  owners: string[];
  server: string[];
  usedAt: Made;
  definedAt: Made;
  elements: string[];
  elementCount: number;
  renders: number | null;
  boundary: boolean;
  suspended: boolean | null;
  watching: Watching;
  changeable: boolean;
};

type Watching = "start" | "late" | "none";

/** The component whose code wrote an element, when a wrapper around it rendered it. */
type Writer = { element: string; id: string; name: string; made: Made } | null;

// Hooks under the custom hooks they are called in, as React DevTools shows them.
function hookLines(hooks: Inspected["hooks"]): string[] {
  const lines: string[] = [];
  let open: string[] = [];
  for (const hook of hooks) {
    let same = 0;
    while (same < open.length && same < hook.path.length && open[same] === hook.path[same]) same += 1;
    for (let level = same; level < hook.path.length; level++) lines.push(`${"  ".repeat(level)}${hook.path[level]}`);
    open = hook.path;
    // A library's custom hook is one line: its key, what it holds, and the hooks it takes.
    const line =
      hook.count === undefined
        ? [`${hook.index} `.padEnd(4), hook.kind, hook.value === undefined ? "" : ` ${hook.value}`, hook.deps === undefined ? "" : `  deps ${hook.deps}`].join("")
        : [
            `${hook.index}${hook.count > 1 ? `-${hook.index + hook.count - 1}` : ""} `.padEnd(4),
            hook.kind,
            hook.deps === undefined ? "" : ` ${hook.deps}`,
            hook.value === undefined ? "" : ` → ${hook.value}`,
          ].join("");
    lines.push(`${"  ".repeat(hook.path.length)}${line}`);
  }
  return lines;
}

// The pages a caveat about joining late was told for, by which load of each.
const told = new WeakMap<object, number>();

async function inspectText(ctx: ActionContext, found: Inspected, writer: Writer, via: Meant["via"]): Promise<string> {
  const [defined, used, written] = await Promise.all([ctx.sources.where(found.definedAt), ctx.sources.where(found.usedAt), writer === null ? null : ctx.sources.where(writer.made)]);
  const lines = [`${found.name} [${found.id}] ${found.kind}${found.compiled ? ", compiled by React Compiler" : ""}${found.boundary ? ", error boundary" : ""}${found.suspended === null ? "" : found.suspended ? ", showing its fallback" : ""}`];
  const field = (label: string, value: string) => lines.push(`${label.padEnd(9)}${value}`);
  if (found.key !== null) field("key", JSON.stringify(found.key));
  if (defined !== null) field("source", placeText(defined));
  if (used !== null) field("used at", placeText(used));
  if (found.owners.length > 0) field("owners", found.owners.join(" < "));
  if (found.server.length > 0) field("server", found.server.join(" < "));
  const elements = found.elementCount === 0 ? "none" : `${found.elements.join(" ")}${found.elementCount > found.elements.length ? ` …${found.elementCount - found.elements.length} more` : ""}`;
  field("elements", elements);
  if (via !== null) field("via", `${via.name} [${via.id}] from ${via.from ?? "node_modules"} rendered the element ("library": true inspects it)`);
  if (writer !== null) field("written", `${writer.name} [${writer.id}] wrote the ${writer.element}${written === null ? "" : `, at ${placeText(written)}`}, and ${found.name} renders it`);
  if (found.renders !== null) field("renders", `${found.renders} since the page loaded`);
  const block = (title: string, rows: string[]) => {
    if (rows.length > 0) lines.push(title, ...rows.map((row) => `  ${row}`));
  };
  block("props", found.props.map(([key, value]) => `${key}: ${value}`));
  block("state", found.state.map(([key, value]) => `${key}: ${value}`));
  block("hooks", hookLines(found.hooks));
  block("context", found.contexts.map(([name, value]) => `${name}: ${value}`));
  const caveat =
    found.watching === "none"
      ? "weblab joined after React loaded and can't see its commits, so nothing is counted, custom hooks aren't named, and nothing can be changed"
      : found.watching === "late"
        ? `weblab joined after React loaded: renders are counted from then${found.changeable ? "" : ", custom hooks aren't named, and props and state can't be changed"}`
        : null;
  // Said once for each page it is true of, not after every inspect.
  if (caveat !== null && told.get(ctx.page) !== ctx.loads()) {
    told.set(ctx.page, ctx.loads());
    lines.push("", `(${caveat}. Reload the page, and weblab's hook goes in before React from then on.)`);
  }
  return lines.join("\n");
}

type Row = { id: string; name: string; count: number; compiled: boolean; reasons: [reason: string, times: number][]; ms: number };
type Renders = { commits: number; ms: number; rows: Row[]; hidden: { components: number; renders: number }; unmounted: { name: string; count: number }[]; watching: Watching };

// How many of a component's renders had each reason, most first.
const reasonText = (reasons: [string, number][], count: number) =>
  reasons.sort((a, b) => b[1] - a[1]).map(([reason, times]) => (count > 1 ? `${times}× ${reason}` : reason));

// Rows shown before the rest are counted, and how many instances of one component make one line of them.
const RENDER_ROWS = 80;
const GROUPED = 3;

function rendersText(found: Renders, under: string | null): string {
  if (found.watching === "none") return "weblab can't see React's commits on this page: React loaded before weblab joined, with no hook to join. Reload the page, and weblab's hook goes in before React from then on.";
  if (found.commits === 0 && found.unmounted.length === 0) return "nothing rendered since the last time asked";
  if (under !== null && found.rows.length === 0 && found.hidden.components === 0 && found.unmounted.length === 0) return `nothing within ${under} rendered since the last time asked`;
  const ms = found.ms > 0 ? ` (${found.ms.toFixed(1)} ms rendering)` : "";
  const count = found.rows.length + found.hidden.components;
  const lines = [
    under === null
      ? `${plural(found.commits, "commit")} since the last time asked${ms}, ${plural(count, "component")} rendered`
      : `${plural(count, "component")} within ${under} rendered since the last time asked`,
  ];
  // Many instances of one component (a list's items) are one line, their renders and reasons added up.
  const byName = new Map<string, Row[]>();
  for (const row of found.rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  const shown = [...byName.values()].flatMap((rows): { label: string; count: number; ms: number; reasons: string[] }[] => {
    const mark = rows[0]?.compiled ? " (compiled)" : "";
    if (rows.length < GROUPED) return rows.map((row) => ({ label: `${row.name} [${row.id}]${mark}`, count: row.count, ms: row.ms, reasons: reasonText(row.reasons, row.count) }));
    const reasons = new Map<string, number>();
    for (const row of rows) for (const [reason, times] of row.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + times);
    const count = rows.reduce((sum, row) => sum + row.count, 0);
    const label = `${rows[0]?.name} ×${rows.length} [${rows[0]?.id} …]${mark}`;
    return [{ label, count, ms: rows.reduce((sum, row) => sum + row.ms, 0), reasons: reasonText([...reasons], count) }];
  });
  shown.sort((a, b) => b.count - a.count || b.ms - a.ms);
  const width = Math.min(48, Math.max(...shown.map((row) => row.label.length)));
  for (const row of shown.slice(0, RENDER_ROWS)) {
    const time = row.ms >= 0.1 ? `${row.ms.toFixed(1)} ms` : "<0.1 ms";
    const head = `  ${row.label.padEnd(width)}  ${`${row.count}×`.padStart(5)}  ${time.padStart(8)}  `;
    // Several reasons go one to a line, under the first.
    lines.push(`${head}${row.reasons[0] ?? ""}`, ...row.reasons.slice(1).map((reason) => `${" ".repeat(head.length)}${reason}`));
  }
  if (shown.length > RENDER_ROWS) lines.push(`  …${shown.length - RENDER_ROWS} more, rendered least`);
  if (found.unmounted.length > 0) lines.push(`unmounted: ${found.unmounted.map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name)).join(", ")}`);
  if (found.hidden.components > 0) {
    lines.push(`(${plural(found.hidden.renders, "render")} of ${plural(found.hidden.components, "component")} from node_modules left out, shown with "library": true)`);
  }
  return lines.join("\n");
}

// ---- the step

export const reactSteps: Record<string, Action> = {
  react: Object.assign(async (ctx: ActionContext, args: unknown) => {
    const given = typeof args === "string" ? { [args]: true } : args;
    if (!isObject(given)) return bad("react", SHAPE);
    const actions = REACT_ACTIONS.filter((action) => given[action] !== undefined);
    if (actions.length !== 1) return bad("react", `one of ${REACT_ACTIONS.join(", ")}: ${SHAPE}`);
    const action = actions[0] as ReactAction;
    const target = given[action];
    const stray = Object.keys(given).find((key) => key !== action && !OPTIONS[action].includes(key));
    if (stray !== undefined) return ctx.usage(`react: ${action} has no option "${stray}" (it takes ${OPTIONS[action].join(", ")})`);
    const nth = typeof given.nth === "number" ? given.nth : undefined;
    const library = given.library === true;
    // A prop, hook or class state, by name or number and a path inside: "0.user", or [0, "user"].
    const pathOf = (kind: "prop" | "hook" | "state"): unknown[] => {
      const at = given[kind];
      const path: unknown[] = Array.isArray(at) ? [...at] : typeof at === "string" ? at.split(".") : [at];
      if (kind === "hook" && typeof path[0] === "string" && /^\d+$/.test(path[0])) path[0] = Number(path[0]);
      if (kind === "hook" && typeof path[0] !== "number") return bad("react", `hook as the hook's number (inspect lists them), or its number and a path: [0, "user"] or "0.user"`);
      return path;
    };
    const which = (["prop", "hook", "state"] as const).filter((key) => given[key] !== undefined);

    switch (action) {
      case "tree": {
        const depth = given.depth === undefined ? null : Number(given.depth);
        const under = target === true ? null : (await component(ctx, target, nth, library)).id;
        const tree = await inPage<{ lines: string[]; more: number; hidden: number }>(ctx, "_tree", [under, depth, TREE_LIMIT, library]);
        if (tree.more > 0) tree.lines.push(`… ${tree.more} more components (give tree a component to start from, or a depth)`);
        if (tree.hidden > 0) tree.lines.push(`(${plural(tree.hidden, "component")} from node_modules left out, shown with "library": true)`);
        return tree.lines.join("\n");
      }
      case "inspect": {
        const meant = await component(ctx, target, nth, library);
        if (which.length > 1) return bad("react", `inspect: one of prop, hook or state, to read one value in full`);
        if (which.length === 1) return inPage<string>(ctx, "_value", [meant.id, which[0], pathOf(which[0] as "prop" | "hook" | "state")]);
        const writer: Writer = meant.element === null ? null : await meant.element.evaluate((node) => (window as any).weblab.react._writer(node)).catch(() => null);
        return inspectText(ctx, await inPage<Inspected>(ctx, "_inspect", [meant.id, library]), writer, meant.via);
      }
      case "renders":
        // All of them, or those within one component. Read and cleared, or with keep, read and kept.
        const under = target === true ? null : (await component(ctx, target, nth, library)).id;
        return rendersText(await inPage<Renders>(ctx, "_renders", [library, under, given.keep === true]), under);
      case "set": {
        if (which.length !== 1 || ("value" in given) === ("js" in given)) return bad("react", `set: a component, one of prop, hook or state, and a value (or js, an expression that makes it in the page: "new Set(['a'])")`);
        const kind = which[0] as "prop" | "hook" | "state";
        const path = pathOf(kind);
        const id = (await component(ctx, target, nth, library)).id;
        // A value JSON can't hold (a Set, a Map, a Date) is made in the page, and handed over as it is.
        if (typeof given.js === "string") {
          const made = await ctx.page.evaluateHandle(given.js).catch((error) => ctx.usage(`react: set's js threw: ${thrown(error)}`));
          try {
            const named = await inPage<string>(ctx, "_set", [id, kind, path, made]);
            return `${kind} ${path.join(".")} of ${named} set to ${given.js}`;
          } finally {
            await made.dispose();
          }
        }
        const named = await inPage<string>(ctx, "_set", [id, kind, path, given.value]);
        return `${kind} ${path.join(".")} of ${named} set to ${JSON.stringify(given.value)}`;
      }
      case "suspend":
      case "error": {
        const release = target === false;
        // React logs the error it is made to throw. It is weblab's own, not the app's.
        if (action === "error" && !release) ctx.ignore(["Simulated error coming from DevTools"]);
        const ids = await inPage<string[]>(ctx, action === "suspend" ? "_suspend" : "_error", [release ? false : (await component(ctx, target, nth, library)).id]);
        if (release) return ids.length === 0 ? `no ${action === "suspend" ? "Suspense" : "error"} boundary was forced` : `${ids.join(", ")} let go`;
        return action === "suspend"
          ? `${ids.join(", ")} shows its fallback, until { "react": { "suspend": false } }`
          : `${ids.join(", ")} shows its error state, until { "react": { "error": false } } or the app resets it`;
      }
    }
  }, { prints: true }),
};

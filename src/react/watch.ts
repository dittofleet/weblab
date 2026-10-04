// Seeing React in a session's pages: the hook in every page it opens,
// and the `component` selector engine the component target uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectors, type BrowserContext } from "playwright-core";
import { REACT_ITSELF } from "../sources.ts";
import { reactInPage } from "./page.ts";

const options = (early: boolean) => ({ early, reactOwn: REACT_ITSELF.source });

/** `weblab.react` put into a page that loaded before the hook was there: what a step runs first on such a page. */
export const INSTALL = `(${reactInPage.toString()})(${JSON.stringify(options(false))})`;

// `component=CartItem` or `component=c12`: the first element each instance renders.
// Playwright builds every registered engine into each page's scripts, so
// weblab.react is put in only when a component target is first used.
const COMPONENT_ENGINE = `(() => {
  const elements = (root, selector) => {
    if (!window.weblab?.react) ${INSTALL};
    return window.weblab.react._elements(selector.trim(), root);
  };
  return {
    query: (root, selector) => elements(root, selector)[0] ?? null,
    queryAll: (root, selector) => elements(root, selector),
  };
})()`;

// Once per process: an engine is registered for every context, past and to come.
let registering: Promise<void> | undefined;
// The contexts the hook is in already.
const watched = new WeakSet<BrowserContext>();

/**
 * Puts the hook in every page a context loads from now on, before the
 * page's own scripts, so React reports to it from the start. A hook
 * already there (React DevTools', React Refresh's) is joined, not
 * replaced, and what weblab adds goes with its connection when it leaves.
 */
export async function watchReact(context: BrowserContext): Promise<void> {
  await registerComponents();
  if (watched.has(context)) return;
  watched.add(context);
  await context.addInitScript(reactInPage, options(true));
}

/** True when the project depends on React: its sessions watch React from their first page, the rest from their first react step. */
export function usesReact(root: string): boolean {
  try {
    const project = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return ["dependencies", "devDependencies", "peerDependencies"].some((field) => project[field]?.react !== undefined);
  } catch {
    return false;
  }
}

/** Registers the component target's engine, which every session can use. */
export async function registerComponents(): Promise<void> {
  // A registration that failed (its context closing) is tried again by the next session.
  registering ??= selectors.register("component", { content: COMPONENT_ENGINE }).catch((error) => {
    registering = undefined;
    throw error;
  });
  await registering;
}

/** Leaves the pages of a browser or app weblab joined as it found them: what weblab put into them taken out. */
export async function unwatchReact(context: BrowserContext): Promise<void> {
  for (const tab of context.pages()) await tab.evaluate(() => (window as any).weblab?.react?._detach()).catch(() => {});
}

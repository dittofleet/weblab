// Getting around: where the page is, which tab steps act on, its size and colour scheme.
import { openedByWeblab } from "../tabs.ts";
import { viewportSize } from "../util.ts";
import type { Action, ActionContext, Ready } from "../types.ts";
import { arg, bad, isObject, step } from "./args.ts";

// Until the root has children a cold vite server has answered "load"
// but the app has not mounted (it may even reload once it has
// optimized its deps). A page with neither root is ready when loaded.
const defaultReady = () => {
  const root = document.querySelector("#root, #app");
  return root ? root.childElementCount > 0 : document.readyState === "complete";
};
const READY_TIMEOUT = 60_000;

export const READY_KEYS = ["selector", "text", "js", "timeout"];

/** What a step was given as `ready`: false, true for the session's own, or { selector | text | js, timeout }. */
export function readyArg(action: string, given: unknown): Ready | false | undefined {
  if (given === undefined || given === true) return undefined;
  if (given === false) return false;
  const ready = isObject(given) ? (given as Ready) : null;
  if (ready === null || Object.keys(ready).some((key) => !READY_KEYS.includes(key))) bad(action, `ready to be true, false, or { selector | text | js, timeout }`);
  return ready;
}

/** Waits for what the session says "ready" means (its `ready` option), or the default, on whatever page the tab is on. */
export async function waitReady(ctx: ActionContext, given: Ready | false | undefined): Promise<void> {
  if (given === false) return;
  const ready = given ?? ctx.app.settings.ready ?? {};
  // A cold dev server can take a while, so ready gets at least a minute.
  const timeout = ready.timeout ?? Math.max(ctx.timeout, READY_TIMEOUT);
  if (ready.selector !== undefined) {
    await ctx.page.locator(ready.selector).first().waitFor({ timeout });
  } else if (ready.text !== undefined) {
    await ctx.page.getByText(ready.text).first().waitFor({ timeout });
  } else {
    // Polled from outside rather than with waitForFunction, which turns
    // its check into code inside the page, and a strict Content
    // Security Policy forbids that.
    const check = ready.js;
    const holds = () => (check === undefined ? ctx.page.evaluate(defaultReady) : ctx.page.evaluate(check)).catch(() => false);
    for (const deadline = Date.now() + timeout; !(await holds()); ) {
      if (Date.now() >= deadline) {
        throw new Error(`the app wasn't ready after ${timeout} ms, waiting for ${check ?? "#root or #app to have children, or the page to load"}`);
      }
      await ctx.page.waitForTimeout(100);
    }
  }
  // A beat for whatever the app does the moment it mounts.
  await ctx.page.waitForTimeout(250);
}

// After going somewhere: a page that left the app (a redirect elsewhere) is not the app to wait for.
async function appReady(ctx: ActionContext, given: Ready | false | undefined): Promise<void> {
  if (ctx.origin !== "" && !ctx.page.url().startsWith(ctx.origin)) return;
  await waitReady(ctx, given);
}

/** A path is resolved against the app's origin; a full URL stands as it is. */
function absolute(ctx: ActionContext, url: string, action: string): string {
  try {
    return new URL(url, ctx.origin === "" ? undefined : `${ctx.origin}/`).href;
  } catch {
    return ctx.usage(`${action}: "${url}" is a path, and there is no origin to resolve it against; give a full URL, or open the session with an address`);
  }
}

// In a recording the drawn cursor starts each page in the middle.
function centerMouse(ctx: ActionContext): Promise<void> {
  const size = ctx.video ? ctx.page.viewportSize() : null;
  if (size === null) return Promise.resolve();
  ctx.mouse = { x: size.width / 2, y: size.height / 2 };
  return ctx.page.mouse.move(ctx.mouse.x, ctx.mouse.y);
}

// Which tabs the steps have been on, per browser context, so `"new"`
// can tell a tab that just opened from one already used.
const visitedByContext = new WeakMap<object, WeakSet<object>>();
function visitedTabs(ctx: ActionContext): WeakSet<object> {
  let visited = visitedByContext.get(ctx.context);
  if (visited === undefined) visitedByContext.set(ctx.context, (visited = new WeakSet()));
  visited.add(ctx.page);
  return visited;
}

export const navigationSteps: Record<string, Action> = {
  goto: step(async (ctx, args) => {
    const { url, ready } = arg<{ url: string; ready?: unknown }>(args, "url", "goto");
    if (typeof url !== "string") bad("goto", `a path or URL, or { url, ready }`);
    const response = await ctx.page.goto(absolute(ctx, url, "goto"), { waitUntil: "load" });
    // The page loaded, but as an error page: worth knowing before trusting a screenshot of it.
    if (response !== null && response.status() >= 400) ctx.note(`${url} answered ${response.status()}`);
    await appReady(ctx, readyArg("goto", ready));
    await centerMouse(ctx);
  }),

  reload: step(async (ctx, args) => {
    if (args !== true && args !== undefined && !isObject(args)) bad("reload", "no argument, or { ready }");
    await ctx.page.reload({ waitUntil: "load" });
    await appReady(ctx, isObject(args) ? readyArg("reload", args.ready) : undefined);
  }),

  ready: step(async (ctx, args) => {
    if (args !== true && !isObject(args)) bad("ready", "true, or { selector | text | js, timeout }");
    // A page still loading (a cold dev build, an app's window just opened) is waited for as goto would.
    await waitReady(ctx, readyArg("ready", args));
  }),

  back: step(async (ctx) => {
    const before = ctx.page.url();
    await ctx.page.goBack({ waitUntil: "load" });
    // A new tab's history starts at a blank page, which is not somewhere to go back to.
    if (ctx.page.url() === "about:blank" && before !== "about:blank") {
      await ctx.page.goForward({ waitUntil: "load" });
      ctx.fail("there's no page before this one in the tab's history");
    }
  }, { noArgs: true }),

  tab: step(async (ctx, args) => {
    const timeout = ctx.timeout;
    const pages = () => ctx.context.pages();
    const visited = visitedTabs(ctx);
    const index = typeof args === "number" ? args : typeof args === "string" && /^\d+$/.test(args) ? Number(args) : null;
    // A tab a click just opened takes a moment to exist.
    const eventually = async <T>(find: () => T | undefined): Promise<T | undefined> => {
      for (const deadline = Date.now() + timeout; find() === undefined && Date.now() < deadline; ) {
        await new Promise((tick) => setTimeout(tick, 50));
      }
      return find();
    };
    if (isObject(args) && args.open !== undefined) {
      const opened = await ctx.context.newPage();
      openedByWeblab.set(opened, ctx.page);
      ctx.page = opened;
      await opened.goto(absolute(ctx, String(args.open), "tab"), { waitUntil: "load" });
    } else if (isObject(args) && args.close !== undefined) {
      const closing = typeof args.close === "number" ? pages()[args.close] : ctx.page;
      if (closing === undefined) ctx.fail(`there is no tab ${args.close}`);
      await ctx.film.closing(closing);
      await closing.close();
      if (closing === ctx.page) ctx.page = pages().at(-1) ?? ctx.fail("the last tab was closed");
    } else if (args === "new") {
      // The newest tab the steps have not been on yet.
      const fresh = await eventually(() => pages().findLast((page) => !visited.has(page)));
      ctx.page = fresh ?? ctx.fail("no new tab opened");
    } else if (args === "last") {
      ctx.page = pages().at(-1) as typeof ctx.page;
    } else if (index !== null) {
      ctx.page = (await eventually(() => pages()[index])) ?? ctx.fail(`there is no tab ${index}`);
    } else {
      bad("tab", `a tab number (from 0), "new", "last", { open: url }, or { close: true | number }`);
    }
    visited.add(ctx.page);
    await ctx.page.bringToFront();
    // A take being recorded follows the steps to this tab.
    await ctx.film.follow(ctx.page);
  }),

  viewport: step(async (ctx, args) => {
    const { width, height, deviceScaleFactor } = (typeof args === "string" ? viewportSize(args) : args) ?? {};
    if (typeof width !== "number" || typeof height !== "number") bad("viewport", `{ width, height } or "800x600"`);
    if (deviceScaleFactor !== undefined) bad("viewport", `a size alone: the pixel scale is set when the session opens (new's viewport: "800x600@2")`);
    await ctx.page.setViewportSize({ width, height });
  }),

  colorScheme: step(async (ctx, args) => {
    const schemes = { dark: "dark", light: "light", none: "no-preference", "no-preference": "no-preference" } as const;
    const colorScheme = schemes[args as keyof typeof schemes];
    if (colorScheme === undefined) bad("colorScheme", `"dark", "light" or "none"`);
    await ctx.page.emulateMedia({ colorScheme });
  }),
};

// Running code: the steps that can do anything the browser can.
//   js           JavaScript inside the page, as the page's own code would run
//   css          a stylesheet added to the page
//   playwright   Playwright code driving the page from outside
//   cdp          one raw Chrome DevTools Protocol command
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { Action, ActionContext } from "../types.ts";
import { arg, bad, step } from "./args.ts";

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (
  ...args: unknown[]
) => Promise<unknown>;

/** What Playwright code is handed: Playwright itself, and weblab's own helpers. */
const codeScope = (ctx: ActionContext) => ({
  page: ctx.page,
  context: ctx.context,
  origin: ctx.origin,
  step: ctx.step,
  newSession: ctx.newSession,
  locate: ctx.locate,
  cdp: ctx.cdp,
  logs: ctx.logs,
  responses: ctx.responses,
  params: ctx.params,
  ctx,
});

// A code file's default export, given the scope.
async function runFile(ctx: ActionContext, file: string, scope: unknown): Promise<unknown> {
  // By its real path: Bun keeps a stale listing of a directory reached
  // through a symlink (/tmp, $TMPDIR), and misses files made since.
  const path = realpathSync(await ctx.resolveFile(file));
  // A process loads a module once per address, so the file's own
  // changes are part of its address: an edited file is loaded anew.
  const module = await import(`${path}?changed=${statSync(path).mtimeMs}`);
  if (typeof module.default !== "function") {
    return ctx.usage(`${file} has no default export: write it as export default async ({ page, step }) => { ... }`);
  }
  return module.default(scope);
}

export const codeSteps: Record<string, Action> = {
  js: step(async (ctx, args) => {
    const { code, file } = arg<{ code?: string; file?: string }>(args, "code", "js");
    if (typeof file === "string") return ctx.page.evaluate(readFileSync(await ctx.resolveFile(file), "utf8"));
    if (typeof code !== "string") return bad("js", `a JavaScript expression, as a string, or { file }`);
    return ctx.page.evaluate(code);
  }),

  css: step(async (ctx, args) => {
    if (typeof args !== "string") bad("css", "CSS, as a string");
    await ctx.page.addStyleTag({ content: args });
    // Pages loaded from now on get it too, as soon as they have a document.
    await ctx.context.addInitScript((css: string) => {
      const add = () => document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add, { once: true });
    }, args);
  }),

  playwright: step(async (ctx, args) => {
    const { code, file } = arg<{ code?: string; file?: string }>(args, "code", "playwright");
    const scope = codeScope(ctx);
    // The body of an async function: `await page.getByRole("button").click(); return page.url()`.
    if (typeof code === "string") return new AsyncFunction(...Object.keys(scope), code)(...Object.values(scope));
    if (typeof file === "string") return runFile(ctx, file, scope);
    return bad("playwright", "Playwright code as a string, or { file }");
  }),

  cdp: step(async (ctx, args) => {
    const { method, params } = arg<{ method?: string; params?: Record<string, unknown> }>(args, "method", "cdp");
    if (typeof method !== "string") return bad("cdp", `"Domain.method", or { method, params }`);
    return ctx.cdp(method, params);
  }),
};

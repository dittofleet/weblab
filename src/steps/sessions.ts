// More than one session: a second user in a browser of their own,
// another running app, another engine, a copy of the app at another
// address. Each has a name, and any step says which it is for with `on`.
import type { Action, SessionOptions } from "../types.ts";
import { bad, isObject, step } from "./args.ts";

export const SESSION_KEYS = ["name", "dir", "address", "start", "startTimeout", "path", "attach", "tab", "newTab", "browser", "browserArgs", "headed", "persist", "state", "viewport", "context", "video", "trace", "timeout", "ignore", "ready", "out"];

export const sessionSteps: Record<string, Action> = {
  new: step(`open another session, as the new tool does; what isn't said is as the session the step is on: "name" or { name, address, start, attach, state, viewport, ... }`, async (ctx, args) => {
    if (typeof args !== "string" && !isObject(args) && args !== true) bad("new", `a name, or { ${SESSION_KEYS.join(", ")} }`);
    await ctx.newSession(typeof args === "string" ? { name: args } : args === true ? {} : (args as SessionOptions));
  }),

  end: step(`end a session, as the end tool does: "name", or true for the session the step is on`, async (ctx, args) => {
    if (typeof args !== "string" && args !== true) bad("end", `a session's name, or true`);
    await ctx.endSession(args === true ? ctx.name : args);
  }),
};

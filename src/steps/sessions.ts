// More than one session: a second user in a browser of their own,
// another running app, another engine, a copy of the app at another
// address. Each has a name, and any step says which it is for with `on`.
import type { Action, SessionOptions } from "../types.ts";
import { bad, isObject } from "./args.ts";

export const SESSION_KEYS = ["name", "dir", "address", "start", "startTimeout", "path", "attach", "tab", "newTab", "mainProcess", "browser", "browserArgs", "headed", "persist", "state", "viewport", "context", "trace", "timeout", "ignore", "ready", "init", "out"];

export const sessionSteps: Record<string, Action> = {
  new: async (ctx, args) => {
    if (typeof args !== "string" && !isObject(args) && args !== true) bad("new", `a name, or { ${SESSION_KEYS.join(", ")} }`);
    await ctx.newSession(typeof args === "string" ? { name: args } : args === true ? {} : (args as SessionOptions));
  },

  end: async (ctx, args) => {
    if (typeof args !== "string" && args !== true) bad("end", `a session's name, or true`);
    await ctx.endSession(args === true ? ctx.name : args);
  },
};

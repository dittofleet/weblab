// Around the page: dialogs, requests answered locally, and saved sign-ins.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { signInPath } from "../state.ts";
import type { Action } from "../types.ts";
import { briefError } from "../errors.ts";
import { arg, bad, isObject, step } from "./args.ts";

export const browserSteps: Record<string, Action> = {
  // Until a step says otherwise, dialogs are dismissed (see sessions.ts).
  dialog: step(async (ctx, args) => {
    const policy = typeof args === "string" ? { accept: args === "accept" } : args;
    const named = typeof args !== "string" || args === "accept" || args === "dismiss";
    if (!isObject(policy) || typeof policy.accept !== "boolean" || !named) {
      bad("dialog", `"accept", "dismiss", or { accept, text }`);
    }
    // Changed in place: the session's dialog handler holds this very object.
    ctx.dialogs.accept = policy.accept as boolean;
    ctx.dialogs.text = policy.text as string | undefined;
  }),

  mock: step(async (ctx, args) => {
    if (!isObject(args) || typeof args.url !== "string") {
      bad("mock", "{ url, json | body | abort | off, status, contentType }");
    }
    const { url, json, body, status, contentType, abort, off } = args as {
      url: string;
      json?: unknown;
      body?: string;
      status?: number;
      contentType?: string;
      abort?: boolean;
      off?: boolean;
    };
    // Checked now, while the step can still fail: inside the route, a bad value only breaks the request.
    const code = status === undefined ? undefined : Number(status);
    if (code !== undefined && !(Number.isInteger(code) && code >= 100 && code <= 599)) bad("mock", `a status from 100 to 599, not ${JSON.stringify(status)}`);
    if (body !== undefined && typeof body !== "string") bad("mock", `a body that is text; for data, use json`);
    await ctx.context.unroute(url);
    if (off) return;
    await ctx.context.route(url, (route) => {
      ctx.mocked.add(route.request());
      const answer = abort ? route.abort() : route.fulfill({ status: code, contentType, ...(json === undefined ? { body } : { json }) });
      return answer.catch((error) => ctx.log(`mock ${url} could not answer ${route.request().url()}: ${briefError(error)}`));
    });
  }),

  saveState: step(async (ctx, args) => {
    const { name } = arg<{ name: string }>(args, "name", "saveState");
    if (typeof name !== "string") bad("saveState", "a name");
    const path = signInPath(ctx.app, name);
    mkdirSync(dirname(path), { recursive: true });
    await ctx.context.storageState({ path });
    ctx.log(`state ${name} saved`);
  }),
};

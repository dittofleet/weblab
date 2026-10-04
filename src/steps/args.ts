// Shared by the step modules: how a step is declared, and how its
// arguments (straight from JSON) are read and checked.
import { UsageError } from "../errors.ts";
import type { Action, ActionContext } from "../types.ts";

/** A built-in step: the work, and optionally that it takes no argument. */
export const step = (run: (ctx: ActionContext, args: any) => Promise<unknown>, shape: Pick<Action, "noArgs"> = {}): Action => Object.assign(run, shape);

/** Keys any step may carry beside its action. */
export const BESIDE_ACTION = ["timeout", "message", "note", "on"];

/** The step was written wrong: a usage error. A declaration, so TypeScript narrows after it. */
export function bad(action: string, shape: string): never {
  throw new UsageError(`${action}: expected ${shape}`);
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Most steps take a bare value or an object carrying the same thing
 * under one key, plus options: `"shot": "home"` is `"shot": { "as": "home" }`.
 */
export function arg<T>(args: unknown, key: string, action: string): T {
  if (typeof args === "string" || typeof args === "number") return { [key]: args } as T;
  if (!isObject(args)) return bad(action, `a value or { ${key}, ... }`);
  return args as T;
}

export const pick = (from: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));

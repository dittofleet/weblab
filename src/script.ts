// Reading the steps a run is given, inline or from a file: checking
// every step names a known action, filling `${name}` placeholders, and
// expanding `include`. A JSON file is a list of steps; a JS/TS file is
// code, run as one `playwright` step.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { UsageError } from "./errors.ts";
import { BESIDE_ACTION } from "./steps/args.ts";
import { builtinActions } from "./steps/index.ts";
import { nearest } from "./util.ts";
import type { Step } from "./types.ts";

const MAX_INCLUDE_DEPTH = 10;
const CODE = /\.(ts|mts|js|mjs)$/;

// Where a step a file brought in was written: `sign-in.json step 2`.
const ORIGINS = new WeakMap<Step, string>();
export const stepOrigin = (step: Step): string | undefined => ORIGINS.get(step);

// The directory of the file a step was written in: a path the step
// names is read from there.
const BASES = new WeakMap<Step, string>();
export const stepBase = (step: Step): string | undefined => BASES.get(step);

// Steps whose values are code, where `${...}` may be the code's own.
const CODE_STEPS = new Set(["js", "css", "playwright", "cdp"]);

/** A copy of a step with more beside its action, still knowing where it was written. */
export function withDefaults(step: Step, extra: Step): Step {
  const copy = { ...extra, ...step };
  if (ORIGINS.has(step)) ORIGINS.set(copy, ORIGINS.get(step) as string);
  if (BASES.has(step)) BASES.set(copy, BASES.get(step) as string);
  return copy;
}

/** A timeout, if one is given, must be a number of milliseconds. */
export function checkTimeout(timeout: unknown, where: string): void {
  if (timeout !== undefined && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) {
    throw new UsageError(`${where}: timeout is a number of milliseconds, not ${JSON.stringify(timeout)}`);
  }
}

export const actionOf = (step: Step): string | undefined => Object.keys(step).find((key) => !BESIDE_ACTION.includes(key));

function readJson(file: string, where: string): unknown {
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`${where}: no such file: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`${file}: not valid JSON (${(error as Error).message})`);
  }
}

// A default written in a placeholder is text; one that reads as a
// number, true, false or null is that, as a param given in JSON would be.
function typedFallback(text: string): unknown {
  if (/^(-?\d+(\.\d+)?|true|false|null)$/.test(text)) return JSON.parse(text);
  return text;
}

// `${name}` from the params given; `${name=fallback}` when it may be
// left out. Inside code (`js`, `playwright`, ...) a `${...}` nothing
// fills is the code's own, such as a template literal, and is left as
// it is; `lenient` leaves every unfilled one, for steps given directly.
function substitute(value: unknown, params: Record<string, unknown>, file: string, lenient = false): unknown {
  if (typeof value === "string") {
    const placeholder = /\$\{(\w+)(?:=([^}]*))?\}/g;
    const lookup = (whole: string, name: string, fallback: string | undefined) => {
      if (name in params) return params[name];
      if (fallback !== undefined) return typedFallback(fallback);
      if (lenient) return whole;
      throw new UsageError(`${file}: needs "${name}", which neither the include nor params gave (or write \${${name}=default})`);
    };
    // A string that is nothing but one placeholder takes the param's
    // own type, so a number stays a number.
    const only = /^\$\{(\w+)(?:=([^}]*))?\}$/.exec(value);
    if (only !== null) return lookup(value, only[1] as string, only[2]);
    return value.replace(placeholder, (whole, name: string, fallback?: string) => String(lookup(whole, name, fallback)));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, params, file, lenient));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params, file, lenient || CODE_STEPS.has(key))]));
  }
  return value;
}

/** The steps a JSON file holds: a list of them, one step alone, or `{ "steps": [...] }`. */
function stepsOf(parsed: unknown, file: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    if (!("steps" in parsed)) return [parsed];
    const others = Object.keys(parsed).filter((key) => key !== "steps");
    if (others.length > 0) {
      throw new UsageError(`${file}: a file holds steps and nothing else (found ${others.join(", ")}); how a session is driven, such as its viewport, is said when it is opened with new`);
    }
    if (Array.isArray((parsed as { steps: unknown }).steps)) return (parsed as { steps: unknown[] }).steps;
  }
  throw new UsageError(`${file}: expected a list of steps`);
}

/**
 * Checks steps and expands each `include` into the steps it names.
 * `base` is where an include's file is looked for: beside the file the
 * steps came from, or the project for steps given inline.
 */
function expand(steps: unknown[], where: string, base: string, params: Record<string, unknown>, depth = 0, file?: string): Step[] {
  if (depth > MAX_INCLUDE_DEPTH) throw new UsageError(`${where}: includes nest too deep (a cycle?)`);
  return steps.flatMap((step, index) => {
    const at = `${where}step ${index + 1}`;
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new UsageError(`${at}: a step is an object like { "click": "button" }`);
    }
    const keys = Object.keys(step).filter((key) => !BESIDE_ACTION.includes(key));
    if (keys.length !== 1) {
      throw new UsageError(`${at}: expected exactly one action, found ${keys.length}${keys.length === 0 ? "" : ` (${keys.join(", ")})`}; beside it a step may have ${BESIDE_ACTION.join(", ")}`);
    }
    const action = keys[0] as string;
    checkTimeout((step as Step).timeout, at);
    if (action === "include") {
      const given = (step as Step).include as string | { file: string; [param: string]: unknown };
      const { file: included, ...own } = typeof given === "string" ? { file: given } : given;
      if (typeof included !== "string") throw new UsageError(`${at}: include takes a file, or { "file": ..., ...params }`);
      const path = resolve(base, included);
      if (CODE.test(path)) throw new UsageError(`${at}: include brings in a JSON file of steps; run code with { "playwright": { "file": "${included}" } }`);
      // What the include gives, and under it what the run was given.
      const inner = substitute(stepsOf(readJson(path, at), path), { ...params, ...own }, path) as unknown[];
      const expanded = expand(inner, `${at} (${basename(path)}) `, dirname(path), params, depth + 1, basename(path));
      // A timeout, message or session (`on`) on the include reaches
      // every step it brings in that sets none of its own.
      const { timeout, message, on } = step as Step;
      const inherited = { ...(timeout === undefined ? {} : { timeout }), ...(message === undefined ? {} : { message }), ...(on === undefined ? {} : { on }) };
      return expanded.map((inner) => withDefaults(inner, inherited));
    }
    if (builtinActions[action] === undefined) {
      const guess = nearest(action, [...Object.keys(builtinActions), "include"]);
      throw new UsageError(`${at}: unknown step "${action}"${guess === undefined ? "" : ` (did you mean "${guess}"?)`}; every step is listed in the run tool's description`);
    }
    if (file !== undefined) ORIGINS.set(step as Step, `${file} step ${index + 1}`);
    BASES.set(step as Step, base);
    return [step as Step];
  });
}

/** Steps given inline, checked and expanded. Paths in them are read from `base`. */
export function inlineSteps(steps: unknown, base: string, params: Record<string, unknown> = {}): Step[] {
  const list = Array.isArray(steps) ? steps : [steps];
  // Given directly, a `${...}` no param fills stays as written.
  return expand(substitute(list, params, "steps", true) as unknown[], "", base, params);
}

/** The steps of a file: a JSON file's own, or for code, the one step that runs it. */
export function fileSteps(file: string, base: string, params: Record<string, unknown> = {}): Step[] {
  const path = resolve(base, file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new UsageError(`file: no such file: ${path}`);
  if (CODE.test(path)) {
    const step: Step = { playwright: { file: path } };
    BASES.set(step, dirname(path));
    return [step];
  }
  const name = basename(path);
  const steps = substitute(stepsOf(readJson(path, "file"), name), params, name, true) as unknown[];
  return expand(steps, `${name} `, dirname(path), params, 0, name);
}

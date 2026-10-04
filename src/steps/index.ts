// Every built-in step, in the groups the run tool's description and
// docs/steps.md show them in.
import { UsageError } from "../errors.ts";
import { nearest } from "../util.ts";
import type { Action } from "../types.ts";
import { browserSteps } from "./browser.ts";
import { captureSteps } from "./capture.ts";
import { checkSteps, EXPECT_KEYS } from "./checks.ts";
import { codeSteps } from "./code.ts";
import { formSteps } from "./forms.ts";
import { inputSteps } from "./input.ts";
import { navigationSteps, READY_KEYS } from "./navigation.ts";
import { SESSION_KEYS, sessionSteps } from "./sessions.ts";
import { TARGET_KEYS } from "./target.ts";
import { BESIDE_ACTION } from "./args.ts";

export const STEP_GROUPS: [title: string, steps: Record<string, Action>][] = [
  ["Getting around", navigationSteps],
  ["Pointer and keyboard", inputSteps],
  ["Forms", formSteps],
  ["Checking", checkSteps],
  ["Reading and capturing", captureSteps],
  ["Around the page", browserSteps],
  ["Code", codeSteps],
  ["More than one session", sessionSteps],
];

export const builtinActions: Record<string, Action> = Object.assign({}, ...STEP_GROUPS.map(([, steps]) => steps));

/** Every step's name, by group: the built-in ones, and include, which script.ts runs. */
export const STEP_NAMES_BY_GROUP: [title: string, names: string[]][] = [...STEP_GROUPS.map(([title, steps]): [string, string[]] => [title, Object.keys(steps)]), ["Reusing steps", ["include"]]];

export const STEP_NAMES = STEP_NAMES_BY_GROUP.flatMap(([, names]) => names);

// What each step's object form may hold, beside a target where it takes
// one, so a misspelt option fails rather than being quietly ignored.
const POINT = ["x", "y"];
const OWN_KEYS: Record<string, { keys: string[]; target?: boolean }> = {
  goto: { keys: ["url", "ready"] },
  reload: { keys: ["ready"] },
  ready: { keys: READY_KEYS },
  back: { keys: [] },
  tab: { keys: ["open", "close"] },
  viewport: { keys: ["width", "height"] },
  colorScheme: { keys: [] },
  click: { keys: ["button", "count", "modifiers", "position", "force", ...POINT], target: true },
  hover: { keys: ["modifiers", "position", "force", ...POINT], target: true },
  drag: { keys: ["from", "to"] },
  scroll: { keys: ["by", "to"], target: true },
  press: { keys: ["key", "hold"], target: true },
  type: { keys: ["value", "delay"], target: true },
  fill: { keys: ["value"], target: true },
  select: { keys: ["option"], target: true },
  check: { keys: ["checked"], target: true },
  upload: { keys: ["file", "files"], target: true },
  expect: { keys: EXPECT_KEYS, target: true },
  wait: { keys: ["ms"] },
  look: { keys: ["as", "format", "depth"], target: true },
  shot: { keys: ["as", "fullPage", "animations", "screen", "matches", "tolerance"], target: true },
  video: { keys: ["as", "ready"] },
  mock: { keys: ["url", "json", "body", "abort", "off", "status", "contentType"] },
  dialog: { keys: ["accept", "text"] },
  saveState: { keys: ["name"] },
  js: { keys: ["code", "file"] },
  css: { keys: [] },
  playwright: { keys: ["code", "file"] },
  cdp: { keys: ["method", "params"] },
  electron: { keys: ["code", "file"] },
  new: { keys: SESSION_KEYS },
};

/** Stops a step whose object form holds a key the step doesn't know. */
export function checkOptions(action: string, args: unknown): void {
  const known = OWN_KEYS[action];
  if (known === undefined || args === null || typeof args !== "object" || Array.isArray(args)) return;
  const allowed = [...known.keys, ...(known.target ? TARGET_KEYS : [])];
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown === undefined) return;
  const guess = nearest(unknown, allowed);
  const besides = BESIDE_ACTION.includes(unknown) ? `; ${unknown} goes beside the action, not inside it` : "";
  throw new UsageError(
    `${action}: no option "${unknown}"${guess === undefined ? "" : ` (did you mean "${guess}"?)`}${besides}; it takes ${known.keys.join(", ") || "no options"}${known.target ? ", and a target" : ""}`,
  );
}

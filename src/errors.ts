import { readFileSync } from "node:fs";

/** Something was asked for wrongly: a step misspelt, an option that doesn't exist. */
export class UsageError extends Error {}

/** What a session needs couldn't be had: a server, a browser. */
export class SetupError extends Error {}

/** Thrown by ctx.fail(): a step that ran and came out wrong. */
export class StepFailure extends Error {}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export const stripAnsi = (text: string) => text.replace(ANSI, "");

// Playwright errors carry a call log after the first line, which
// drowns the one sentence an agent needs.
export function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [first = ""] = stripAnsi(message).split("\n");
  return first.length > 300 ? `${first.slice(0, 297)}...` : first;
}

/** The last few lines of a log, indented, for an error message: usually the reason something gave up. */
export function tail(file: string, count = 3): string {
  try {
    const lines = stripAnsi(readFileSync(file, "utf8")).split("\n").filter((line) => line.trim() !== "");
    return lines.slice(-count).map((line) => `\n  ${line.trim().slice(0, 200)}`).join("");
  } catch {
    return "";
  }
}

// What Playwright's call log says stopped an action: something on top
// of the element, or the element not yet in a state to act on.
const BLOCKED = /intercepts pointer events$|^element is not |^element is outside of the viewport$|^element was detached/;

/**
 * A failed step's reason in one line. Playwright puts what it was doing
 * in a call log under its first line; a timeout is only useful with
 * the element it was waiting for, so that comes along.
 */
export function stepError(error: unknown): string {
  const message = stripAnsi(error instanceof Error ? error.message : String(error));
  // weblab's own reasons are written to be read whole, list and all.
  if (error instanceof StepFailure) return message;
  const [first = ""] = message.split("\n");
  if (!message.includes("\nCall log:")) return briefError(error);
  const log = message
    .slice(message.indexOf("\nCall log:") + 1)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => line !== "" && line !== "Call log:");
  // The step's name is already printed beside its reason.
  let line = first.replace(/^[\w.]+: /, "").replace(/\.$/, "");
  const waiting = log.find((entry) => entry.startsWith("waiting for "));
  if (/^Timeout \d+ms exceeded$/.test(line) && waiting !== undefined) {
    line = `${line} ${waiting}`;
    // An action retries until it times out, so the log ends in retrying
    // and waiting; why it couldn't act is said further up.
    const reason = log.findLast((entry) => BLOCKED.test(entry));
    const last = log.at(-1);
    if (reason !== undefined) line += `: ${reason}`;
    else if (last !== undefined && last !== waiting) line += ` (last: ${last})`;
    if (waiting.includes("aria-ref=")) line += "; refs come from the last look step, so look again after the page changes";
  }
  return line.length > 400 ? `${line.slice(0, 397)}...` : line;
}

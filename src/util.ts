// Small helpers several modules share.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Viewport } from "./types.ts";

/** Text made safe to use inside a regular expression. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A glob over a whole string, where `*` stands for anything. */
export const globRegExp = (glob: string) => new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`);

/** What a command printed, trimmed, or null if it failed or isn't there. */
export function tryExec(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  try {
    return execFileSync(command, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Where a program is on the PATH, or null. */
export const onPath = (program: string): string | null => {
  const dir = (process.env.PATH ?? "").split(delimiter).find((at) => at !== "" && existsSync(join(at, program)));
  return dir === undefined ? null : join(dir, program);
};

/** The known name closest to a misspelt one, if any is close. */
export function nearest(word: string, names: Iterable<string>): string | undefined {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= b.length; j += 1) {
        next[j] = Math.min((row[j] as number) + 1, (next[j - 1] as number) + 1, (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row[b.length] as number;
  };
  let best: [string, number] | undefined;
  for (const name of names) {
    const score = distance(word.toLowerCase(), name.toLowerCase());
    if (score <= 2 && (best === undefined || score < best[1])) best = [name, score];
  }
  return best?.[0];
}

/** A size written `1440x900`, or `1440x900@2` with a pixel scale; null if it isn't one. */
export function viewportSize(text: string): Partial<Viewport> | null {
  const size = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(text);
  if (size === null) return null;
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    ...(size[3] === undefined ? {} : { deviceScaleFactor: Number(size[3]) }),
  };
}

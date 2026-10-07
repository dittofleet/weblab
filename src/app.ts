// The project a session is opened from: its root, and a label for
// artifact dirs.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { UsageError } from "./errors.ts";
import { fileName } from "./state.ts";
import type { App, Settings } from "./types.ts";
import { tryExec } from "./util.ts";

/** How long a server weblab starts gets to answer, unless `startTimeout` says otherwise. */
export const SERVER_TIMEOUT_MS = 60_000;

const git = (cwd: string, ...args: string[]) => tryExec("git", args, { cwd });

// The app itself: the nearest directory with a package.json, looking
// no higher than the repo. In a monorepo that is the app's own folder.
function nearestPackageDir(from: string, toplevel: string | null): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === toplevel || dirname(dir) === dir) return null;
  }
}

/** Finds the project a directory is in. `settings` is how its session is driven. */
export function resolveApp(dir: string, settings: Settings = {}): App {
  const start = resolve(dir);
  if (!existsSync(start)) throw new UsageError(`dir: no such directory: ${start}`);
  // One git call for both: the checkout's top, and its common git dir,
  // which sits in the main checkout and so names the repo.
  const [toplevel = null, commonDir = null] = git(start, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")?.split("\n") ?? [];
  const root = nearestPackageDir(start, toplevel) ?? toplevel ?? start;

  const repo = commonDir === null ? basename(root) : basename(dirname(commonDir));
  const worktree = basename(toplevel ?? root);
  const within = toplevel === null ? "" : relative(toplevel, root);
  const label = fileName([repo, ...(worktree === repo ? [] : [worktree]), ...(within === "" ? [] : [within])].join("-"));

  return {
    dir: start,
    root,
    toplevel,
    label,
    key: createHash("sha1").update(root).digest("hex").slice(0, 12),
    settings,
  };
}

/** The repository's other checkouts (its other worktrees): where else the same app could be run from. */
export function otherCheckouts(app: App): string[] {
  const listed = app.toplevel === null ? null : git(app.root, "worktree", "list", "--porcelain");
  if (listed === null) return [];
  return listed
    .split("\n\n")
    .map((entry) => entry.split("\n"))
    .filter((lines) => !lines.includes("bare"))
    .map((lines) => lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length))
    // Compared as real paths: a worktree may be recorded by a symlinked path.
    .filter((path): path is string => path !== undefined && existsSync(path) && realpathSync(path) !== realpathSync(app.toplevel as string));
}

/** An address as given (a URL, host:port, or a port) as an origin: `http://localhost:4000`. */
export function originOf(address: string | number): string {
  const text = String(address).trim();
  const url = /^\d+$/.test(text) ? `http://localhost:${text}` : /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const { protocol, host } = new URL(url);
    if (host !== "") return `${protocol}//${host}`;
  } catch {
    // Reported below.
  }
  throw new UsageError(`address: "${text}" isn't a URL, host:port, or a port`);
}

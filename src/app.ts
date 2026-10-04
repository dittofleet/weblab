// The project a session is opened from: its root, a label for artifact
// dirs, where its dev server answers, and how to start it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { UsageError } from "./errors.ts";
import { fileName } from "./state.ts";
import type { App, Settings } from "./types.ts";
import { onPath, tryExec } from "./util.ts";

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
export function resolveApp(dir: string | undefined, settings: Settings = {}): App {
  const start = resolve(dir ?? process.cwd());
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
    root,
    label,
    key: createHash("sha1").update(root).digest("hex").slice(0, 12),
    settings,
  };
}

// Env files may hold secrets, so only the one port line is ever
// matched; nothing else from the file is kept, logged or returned.
function portFromEnvFile(app: App): number | null {
  const path = join(app.root, ".env");
  if (!existsSync(path)) return null;
  const match = /^(?:export\s+)?PORT=["']?(\d+)["']?\s*$/m.exec(readFileSync(path, "utf8"));
  return match === null ? null : Number(match[1]);
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

/**
 * Where a project's own dev server answers, when that is known before
 * it starts: the PORT its .env names. Otherwise the server says, in
 * what it prints when it starts.
 */
export function projectOrigin(app: App): string | null {
  const port = portFromEnvFile(app);
  return port === null ? null : `http://localhost:${port}`;
}

/** True when the app declares dependencies and none are installed, so its dev command cannot run. */
export function dependenciesMissing(app: App): boolean {
  const manifest = join(app.root, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const { dependencies, devDependencies } = JSON.parse(readFileSync(manifest, "utf8"));
    const declared = Object.keys({ ...dependencies, ...devDependencies }).length > 0;
    return declared && !existsSync(join(app.root, "node_modules"));
  } catch {
    return false;
  }
}

const LOCKFILES: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** The project's own `dev` script, as a command, if it has one. */
export function devCommand(app: App): string | null {
  const manifest = join(app.root, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    if (typeof scripts.dev !== "string") return null;
  } catch {
    return null;
  }
  // The project's lockfile says which package manager it uses. Without
  // one, whichever is installed.
  const manager =
    LOCKFILES.find(([file]) => existsSync(join(app.root, file)))?.[1] ??
    ["bun", "pnpm", "yarn", "npm"].find((manager) => onPath(manager) !== null) ??
    "npm";
  return `${manager} run dev`;
}

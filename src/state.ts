// weblab's own files, kept outside every repo in $XDG_STATE_HOME/weblab
// (~/.local/state/weblab by default):
//
//   <name>.json                records: a server weblab started, by its address
//   <name>.lock                one process at a time: on a server's record, a kept profile
//   auth/<project>/<name>.json sign-ins saved with the saveState step
//   profiles/<project>-<browser>/  browser profiles kept by `persist`
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SetupError } from "./errors.ts";
import { alive, startTime } from "./processes.ts";
import type { App } from "./types.ts";

const LOCK_WAIT_MS = 10 * 60_000;

const stateDir = () =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "weblab");

/** Text made safe for a file name. */
export const fileName = (text: string) => text.replace(/[^\w.-]+/g, "-");

/** A name as it appears in the files named after it: `shots/<slug>-home.png`. */
export const slug = (name: string) => fileName(name).replace(/^-+|-+$/g, "") || "unnamed";

// Local time, sortable: 20261002-223245.
const timestamp = () => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
};

/** Where sessions write what they capture: the directory given, else a new one under $TMPDIR/weblab. */
export function artifactsDir(label: string, out: string | undefined): string {
  if (out !== undefined) {
    mkdirSync(resolve(out), { recursive: true });
    return resolve(out);
  }
  mkdirSync(join(tmpdir(), "weblab"), { recursive: true });
  // Two started in the same second each get their own.
  const base = join(tmpdir(), "weblab", `${label}-${timestamp()}`);
  for (let count = 1; ; count += 1) {
    const dir = count === 1 ? base : `${base}-${count}`;
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** A sign-in saved with `saveState`. Never in a repo or an artifacts dir, since it holds live cookies. */
export const signInPath = (app: App, name: string) => join(stateDir(), "auth", app.key, `${fileName(name)}.json`);

/** The browser profile `persist` keeps for a project, one per browser. */
export function profileDir(app: App, browser: string): string {
  const dir = join(stateDir(), "profiles", `${app.key}-${fileName(browser)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- records

const recordPath = (name: string) => join(stateDir(), `${name}.json`);

/** A JSON record weblab keeps, or null when there is none. */
export function readRecord<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(recordPath(name), "utf8"));
  } catch {
    return null;
  }
}

export function writeRecord(name: string, record: unknown): void {
  mkdirSync(stateDir(), { recursive: true });
  // Whole or not at all: a reader never finds half a record.
  const path = recordPath(name);
  const fresh = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(fresh, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(fresh, path);
}

export const clearRecord = (name: string) => rmSync(recordPath(name), { force: true });

/** The records whose names start a given way. */
export function recordNames(prefix: string): string[] {
  try {
    return readdirSync(stateDir())
      .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length));
  } catch {
    return [];
  }
}

// ---- one process at a time

const lockPath = (name: string) => join(stateDir(), `${name}.lock`);

// A lock file holds who took it: the pid, when that process started (so
// a pid used again by something else isn't taken for the holder), and a
// token of this one taking, so only the release that goes with it lets go.
type Held = { pid: number; startedAt: string | null; token: string };

const readLock = (path: string): Held | null => {
  try {
    const [pid, startedAt = "", token = ""] = readFileSync(path, "utf8").split("\n");
    return Number(pid) > 0 ? { pid: Number(pid), startedAt: startedAt || null, token } : null;
  } catch {
    return null;
  }
};

const holderLives = (held: Held) => alive(held.pid) && (held.startedAt === null || startTime(held.pid) === held.startedAt);

/**
 * Takes a lock, and returns the release. `busy` is asked about a live
 * holder: a message says the lock isn't worth waiting for, and null
 * says to wait. This process holding it already is told the same way.
 */
export async function acquireLock(
  name: string,
  options: { busy(holder: number): string | null; waiting?(holder: number): void },
): Promise<() => void> {
  mkdirSync(stateDir(), { recursive: true });
  const path = lockPath(name);
  const token = randomBytes(8).toString("hex");
  const release = () => {
    if (readLock(path)?.token === token) rmSync(path, { force: true });
  };
  // Written whole, then linked into place: the lock never exists
  // without its holder in it, and link() fails if it is taken.
  const mine = `${path}.${token}`;
  writeFileSync(mine, `${process.pid}\n${startTime(process.pid) ?? ""}\n${token}`);
  try {
    let announced = false;
    for (let waited = 0; ; ) {
      try {
        linkSync(mine, path);
        return release;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const held = readLock(path);
      if (held === null) {
        // Gone again already, or not a lock anyone could hold: one that
        // stays unreadable is cleared away.
        await sleep(50);
        try {
          if (readLock(path) === null && Date.now() - statSync(path).mtimeMs > 2000) rmSync(path, { force: true });
        } catch {
          // Gone.
        }
        continue;
      }
      if (!holderLives(held)) {
        // Another process may be the one clearing it away.
        if (!breakStaleLock(path)) await sleep(100);
        continue;
      }
      const busy = options.busy(held.pid);
      if (busy !== null) throw new SetupError(busy);
      if (waited >= LOCK_WAIT_MS) throw new SetupError(`another weblab process (pid ${held.pid}) has held the ${name} lock for ${LOCK_WAIT_MS / 60_000} minutes`);
      if (!announced) {
        options.waiting?.(held.pid);
        announced = true;
      }
      await sleep(200);
      waited += 200;
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

// A lock whose holder has died is removed by one process at a time:
// whoever makes the breaker directory. Inside it nothing else can take
// the dead lock away, so what is checked is what is removed, and a lock
// taken since is never touched.
function breakStaleLock(path: string): boolean {
  const breaker = `${path}.breaking`;
  try {
    mkdirSync(breaker);
  } catch {
    // Someone else is at it. One left by a breaker that died is cleared, for the next try.
    try {
      if (Date.now() - statSync(breaker).mtimeMs > 5000) rmSync(breaker, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
    return false;
  }
  try {
    const held = readLock(path);
    if (held !== null && !holderLives(held)) rmSync(path, { force: true });
    return true;
  } finally {
    rmSync(breaker, { recursive: true, force: true });
  }
}

/** A profile kept by `persist` is one browser's at a time: a second session asking for it is told so. */
export function holdProfile(app: App, browser: string): Promise<() => void> {
  return acquireLock(`${app.key}.profile-${fileName(browser)}`, {
    busy: (holder) =>
      holder === process.pid
        ? "another session is using this project's kept browser profile; end it first, or open this one without persist"
        : `another weblab (pid ${holder}) is using this project's kept browser profile`,
  });
}

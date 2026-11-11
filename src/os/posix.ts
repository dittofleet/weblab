// macOS and Linux: `ps` and `lsof` for what is running, signals to stop it.
import { existsSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { alive, tryExec } from "../util.ts";
import type { Listed, Os } from "./index.ts";

const GRACE_MS = 4000;

// The same zone and locale for every reading of a start time, so one process reads the same from any shell.
const PS_ENV = { ...process.env, TZ: "UTC", LC_ALL: "C" };

// As `ps` prints a start time: "Mon Oct  5 19:48:41 2026", in the zone above.
const STARTED = /\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}/;
const iso = (started: string) => new Date(`${started} GMT`).toISOString();

// A process that has exited but not been collected by its parent yet (a
// zombie) is gone for every purpose here, though it still answers kill(0).
const zombie = (stat: string) => stat.startsWith("Z");

function startTime(pid: number): string | null {
  const match = /^\s*(\S+)\s+(.*)$/.exec(tryExec("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { env: PS_ENV }) ?? "");
  return match === null || zombie(match[1] as string) ? null : iso(match[2] as string);
}

const LISTED = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(${STARTED.source})\\s+(.*)$`);

const table = (): (Listed & { pgid: number })[] =>
  (tryExec("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], { env: PS_ENV }) ?? "").split("\n").flatMap((line) => {
    const match = LISTED.exec(line);
    if (match === null) return [];
    const [, pid, ppid, pgid, stat, startedAt, command] = match as unknown as string[];
    if (zombie(stat as string)) return [];
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startedAt: iso(startedAt as string), command: command as string }];
  });

/** SIGTERM, a grace period, then SIGKILL: to a process, or (negated) a whole group. */
async function terminate(target: number): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(target, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  for (let waited = 0; waited < GRACE_MS && alive(target); waited += 100) {
    await sleep(100);
  }
  if (alive(target)) signal("SIGKILL");
}

// The binary inside a macOS app bundle is named after the app.
function insideApp(bundle: string): string | null {
  const dir = join(bundle, "Contents", "MacOS");
  if (!existsSync(dir)) return null;
  const [first] = readdirSync(dir);
  return first === undefined ? null : join(dir, first);
}

export const posix: Os = {
  processTable: table,
  startTime,
  membersOf: (leader) => table().filter((listed) => listed.pgid === leader),
  // Its group, led by it or left by a leader that has gone. A process
  // that is in another's group (one gone to the background without
  // setsid) heads nothing, so it is stopped alone.
  stopGroup(leader) {
    const listed = table().find((one) => one.pid === leader);
    return terminate(listed === undefined || listed.pgid === leader ? -leader : leader);
  },
  stopProcess: terminate,
  listeners: (port) =>
    (tryExec("lsof", ["-nP", port === undefined ? "-iTCP" : `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]) ?? "").split("\n").map(Number).filter((pid) => pid > 0),
  cwdOf(pid) {
    const listed = tryExec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return listed?.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
  },

  ownGroup: { detached: true },
  // `read` blocks until a line or the end of the pipe: the whole wait is
  // a shell's, so it costs next to nothing, and exec leaves nothing behind.
  unlessDismissed: ([file, ...args]) => ["/bin/sh", "-c", 'read -r line; [ "$line" = done ] || exec "$0" "$@"', file as string, ...args],

  stateHome: () => join(homedir(), ".local", "state"),
  executableAt: (path) => (path.endsWith(".app") ? insideApp(path) : path),
  installedApp(app) {
    for (const applications of ["/Applications", join(homedir(), "Applications")]) {
      const path = insideApp(join(applications, `${app}.app`));
      if (path !== null) return path;
    }
    return null;
  },
  releaseAsset: `weblab-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`,
  replaceBinary: renameSync,
};

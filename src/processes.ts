// Telling whether a process is still the one weblab started, and
// stopping a process group without touching anything else.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { tryExec } from "./util.ts";

const GRACE_MS = 4000;

/** True while the pid (or, negated, the process group) exists. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** When the process started, as `ps` prints it, so a recycled pid can be told apart. */
export const startTime = (pid: number): string | null => {
  try {
    // A fixed zone and locale, so the same process reads the same from any shell.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
};

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

/** Stops a whole process group, but never the one weblab itself runs in. */
export async function killGroup(pgid: number): Promise<void> {
  if (pgid <= 1 || pgid === groupOf(process.pid)) return;
  await terminate(-pgid);
}

/** Stops one process. */
export const killProcess = (pid: number) => terminate(pid);

/** The process group a pid is in. */
export const groupOf = (pid: number): number | null => {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    const pgid = Number(out.toString().trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
};

/** Every pid listening on a local TCP port, as lsof sees them (none if it can't tell). */
export const allListeners = (): Set<number> =>
  new Set((tryExec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-t"]) ?? "").split("\n").map(Number).filter((pid) => pid > 0));

/** The pids listening on a local TCP port, as lsof sees them (none if it can't tell). */
export const listenersOn = (port: number): number[] => {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
};

/** When the process started, in milliseconds since the epoch, or null. */
export const startedAtMs = (pid: number): number | null => {
  const text = startTime(pid);
  if (text === null) return null;
  const ms = Date.parse(`${text} GMT`);
  return Number.isNaN(ms) ? null : ms;
};

/** Every pid in a process group. */
export const groupMembers = (pgid: number): number[] =>
  (tryExec("ps", ["-A", "-o", "pid=,pgid="]) ?? "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid as number);

/** A process's working directory, as lsof sees it, or null. */
export const cwdOf = (pid: number): string | null => {
  const listed = tryExec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return listed?.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
};

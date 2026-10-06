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

/** A process as a record names it: by pid, and by when it started, so a pid used again since is told apart. */
export type Process = { pid: number; startedAt: string | null };

export const processOf = (pid: number): Process => ({ pid, startedAt: startTime(pid) });

// The same zone and locale for every reading of a start time, so one process reads the same from any shell.
const PS_ENV = { ...process.env, TZ: "UTC", LC_ALL: "C" };

// As `ps` prints a start time: "Mon Oct  5 19:48:41 2026".
const STARTED = /\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}/;

// A process that has exited but not been collected by its parent yet (a
// zombie) is gone for every purpose here, though it still answers kill(0).
const zombie = (stat: string) => stat.startsWith("Z");

/** When the process started, as `ps` prints it, or null if it has gone (or is a zombie). */
export const startTime = (pid: number): string | null => {
  const match = /^\s*(\S+)\s+(.*)$/.exec(tryExec("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { env: PS_ENV }) ?? "");
  return match === null || zombie(match[1] as string) ? null : (match[2] as string);
};

/** True while the pid is running, as a zombie isn't. */
export const running = (pid: number) => startTime(pid) !== null;

/** Whether a process is the one a record names: alive, with the start time recorded for it. */
export const isProcess = (pid: number, startedAt: string | null) => startedAt !== null && alive(pid) && startTime(pid) === startedAt;

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

type Listed = Process & { startedAt: string; ppid: number; pgid: number; command: string };

const LISTED = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(${STARTED.source})\\s+(.*)$`);

/** Every process that is running, with its parent, its group, when it started and its command line. */
export const processTable = (): Listed[] =>
  (tryExec("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], { env: PS_ENV }) ?? "").split("\n").flatMap((line) => {
    const match = LISTED.exec(line);
    if (match === null) return [];
    const [, pid, ppid, pgid, stat, startedAt, command] = match as unknown as string[];
    if (zombie(stat as string)) return [];
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startedAt: startedAt as string, command: command as string }];
  });

/** Every pid in a process group. */
export const groupMembers = (pgid: number): number[] => membersOf(pgid).map((member) => member.pid);

/** Every process in a group, as a record names them. */
export const membersOf = (pgid: number): Process[] =>
  processTable()
    .filter((listed) => listed.pgid === pgid)
    .map(({ pid, startedAt }) => ({ pid, startedAt }));

/** A process's working directory, as lsof sees it, or null. */
export const cwdOf = (pid: number): string | null => {
  const listed = tryExec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return listed?.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
};

/** The processes a pid started that lead a process group of their own. */
export const groupLeadersStartedBy = (parent: number): Listed[] => processTable().filter((listed) => listed.ppid === parent && listed.pid === listed.pgid);

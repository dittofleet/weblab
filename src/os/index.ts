// What differs between operating systems, behind one shape, so the
// logic above it reads the same everywhere.
//
// "Group" is the unit weblab starts and stops: a command with whatever
// it runs under it. On macOS and Linux that is a process group. Windows
// has none, so there it is a process and its descendants.
import type { SpawnOptions } from "node:child_process";

/** A running process, as the process table lists it. */
export type Listed = { pid: number; ppid: number; startedAt: string; command: string };

export type Os = {
  /** Every process that is running. */
  processTable(): Listed[];
  /** When a process started, as an ISO date, or null if it has gone. */
  startTime(pid: number): string | null;
  /** The processes of a group, the leader among them while it runs. `since` is when the leader started, for one that may have gone. */
  membersOf(leader: number, since?: string | null): { pid: number; startedAt: string }[];
  /** Stops a process and what it heads, however it answers. */
  stopGroup(leader: number, since?: string | null): Promise<void>;
  /** Stops one process, however it answers. */
  stopProcess(pid: number): Promise<void>;
  /** The pids listening on a local TCP port, or on any (none if it can't tell). */
  listeners(port?: number): number[];
  /** A process's working directory, or null. */
  cwdOf(pid: number): string | null;

  /** For a spawn that starts a group of its own, outlasting weblab. */
  ownGroup: SpawnOptions;
  /** The command line that runs a `weblab --sweep`, unless weblab says "done" on its stdin first. */
  unlessDismissed(sweep: string[]): string[];

  /** Where per-user state goes, when XDG_STATE_HOME doesn't say. */
  stateHome(): string;
  /** The executable a path given for a browser means, or null. */
  executableAt(path: string): string | null;
  /** An installed app's executable, by the name it installs under, or null. */
  installedApp(app: string): string | null;
  /** The release file for this machine. */
  releaseAsset: string;
  /** Puts a new binary where this running one is. */
  replaceBinary(staged: string, running: string): void;
};

// Only the one for this system is loaded: Windows's binds system libraries as it does.
export const os: Os = process.platform === "win32" ? (await import("./windows.ts")).windows : (await import("./posix.ts")).posix;

// Telling whether a process is still the one weblab started, and
// stopping a group of processes without touching anything else. How
// each system answers is in os/.
import { os } from "./os/index.ts";
import { alive } from "./util.ts";

export { alive };

export const { startTime, processTable, cwdOf } = os;

/** A process as a record names it: by pid, and by when it started, so a pid used again since is told apart. */
export type Process = { pid: number; startedAt: string | null };

export const processOf = (pid: number): Process => ({ pid, startedAt: startTime(pid) });

/** True while the pid is running, which an exited process waiting to be collected isn't. */
export const running = (pid: number) => startTime(pid) !== null;

/** Whether a process is the one a record names: alive, with the start time recorded for it. */
export const isProcess = (pid: number, startedAt: string | null) => startedAt !== null && alive(pid) && startTime(pid) === startedAt;

/** Stops a process and what it heads, but never anything weblab itself is in. */
export async function killGroup(leader: number, since?: string | null): Promise<void> {
  if (leader <= 1 || groupMembers(leader, since).includes(process.pid)) return;
  await os.stopGroup(leader, since);
}

/** Stops one process. */
export const killProcess = os.stopProcess;

/** When the process started, in milliseconds since the epoch, or NaN. */
export const startedAtMs = (pid: number): number => Date.parse(startTime(pid) ?? "");

/** Every process in a group, as a record names them. */
export const membersOf = (leader: number, since?: string | null): Process[] => os.membersOf(leader, since).map(({ pid, startedAt }) => ({ pid, startedAt }));

/** Every pid in a group. */
export const groupMembers = (leader: number, since?: string | null): number[] => membersOf(leader, since).map((member) => member.pid);

/** The processes a pid started. */
export const childrenOf = (parent: number) => processTable().filter((listed) => listed.ppid === parent);

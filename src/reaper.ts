// What weblab starts is weblab's to stop, however weblab ends.
//
// Ending a session, the client going, or a signal: the session's
// teardown closes its browser and lets go of its server, and makes sure
// both have gone. Killed outright, weblab can do nothing, so what it
// owns is recorded where another process can find it:
//
//   browser.<pid>.json  a browser weblab launched: its pid (it leads a
//                       process group, its helpers' too), when it
//                       started, its helpers, and which weblab owns it
//   server.<...>.json   a server weblab started, and who is using it (server.ts)
//
// Whatever a weblab that is gone left recorded is stopped by its watcher
// (lifecycle.ts) the moment it goes, and failing that, by the next
// weblab to start. Only a recorded process still running as recorded (the
// same pid, started at the same time) is stopped, so a recycled pid, a
// browser weblab only attached to, or another weblab's (in any checkout)
// is never touched. A server another live weblab still uses stays up.
import { setTimeout as sleep } from "node:timers/promises";
import { alive, groupLeadersStartedBy, isProcess, killGroup, killProcess, membersOf, type Process, processOf, processTable } from "./processes.ts";
import { sweepServers } from "./server.ts";
import { clearRecord, readRecord, recordNames, writeRecord } from "./state.ts";

type BrowserState = Process & {
  owner: Process;
  /** Its helpers, as last seen, so one that outlives it (hung) is still found. */
  members?: Process[];
};

const recordName = (pid: number) => `browser.${pid}`;

// Playwright starts a browser in a process group of its own, talking to
// it over a pipe whose flag is on its command line.
const DRIVEN = /\s(--remote-debugging-pipe|-juggler-pipe|--inspector-pipe)(\s|$)/;
const browsersStarted = () => groupLeadersStartedBy(process.pid).filter((child) => DRIVEN.test(child.command)).map((child) => child.pid);

// How long a browser gets to close when asked, and then to go.
const CLOSE_TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 3000;
// How often a launch is looked in on, so a weblab killed during one leaves a record.
const LOOK_EVERY_MS = 250;

// What is recorded is what is checked, in one reading of the process
// table: a process is only ever the one recorded (the same pid, started
// at the same time), so a pid given out again since (after a reboot,
// say) is never signalled.
function remaining(state: BrowserState): { leader: boolean; helpers: number[] } {
  const table = processTable();
  const is = ({ pid, startedAt }: Process) => startedAt !== null && table.some((listed) => listed.pid === pid && listed.startedAt === startedAt);
  return { leader: is(state), helpers: (state.members ?? []).filter(is).map((member) => member.pid) };
}

// Its helpers come and go as pages do: noted again at each turn, for the
// sweep. The record is only ever written over by its own browser's.
const remember = (state: BrowserState) => {
  state.members = membersOf(state.pid).filter((member) => member.pid !== state.pid);
  writeRecord(recordName(state.pid), state);
};

// The record on disk is this browser's: not one written since for a browser that got its pid.
const recorded = (state: BrowserState) => {
  const now = readRecord<BrowserState>(recordName(state.pid));
  return now !== null && now.startedAt === state.startedAt && now.owner?.pid === state.owner.pid;
};

// Stopped if it hasn't gone by itself, and forgotten: the whole group
// while the browser leads it, or else whichever helpers outlived it.
async function stop(state: BrowserState, graceMs: number): Promise<void> {
  let left = remaining(state);
  for (let waited = 0; waited < graceMs && (left.leader || left.helpers.length > 0); waited += 100) {
    await sleep(100);
    left = remaining(state);
  }
  if (left.leader) await killGroup(state.pid);
  else await Promise.all(left.helpers.map(killProcess));
  if (recorded(state)) clearRecord(recordName(state.pid));
}

// One launch at a time in this process, so each knows which browser is its.
let launches: Promise<unknown> = Promise.resolve();

/**
 * Launches a browser as weblab's own, and hands back a close that makes
 * sure of it. The browser is recorded as soon as it appears, before
 * Playwright has even finished with it, so a weblab killed mid-launch
 * leaves it to the watcher too. A launch that fails stops whatever it started.
 */
export function ownBrowser<T>(launch: () => Promise<T>, close: (value: T) => Promise<void>): Promise<{ value: T; close(): Promise<void> }> {
  const turn = launches.then(() => tracked(launch, close));
  launches = turn.catch(() => {});
  return turn;
}

async function tracked<T>(launch: () => Promise<T>, close: (value: T) => Promise<void>): Promise<{ value: T; close(): Promise<void> }> {
  const before = new Set(browsersStarted());
  const owner = processOf(process.pid);
  const found = new Map<number, BrowserState>();
  const look = () => {
    for (const pid of browsersStarted()) {
      if (before.has(pid) || found.has(pid)) continue;
      const state = { ...processOf(pid), owner };
      found.set(pid, state);
      try {
        writeRecord(recordName(pid), state);
      } catch {
        // Not written down (a full disk): this process still closes it, only a sweep wouldn't find it.
      }
    }
  };
  const looking = setInterval(look, LOOK_EVERY_MS);
  const [outcome] = await Promise.allSettled([launch()]);
  clearInterval(looking);
  look();
  const states = [...found.values()];
  if (outcome.status === "rejected") {
    await Promise.all(states.map((state) => stop(state, 0)));
    throw outcome.reason;
  }
  for (const state of states) remember(state);
  const { value } = outcome;
  return {
    value,
    // Asked to close, then made sure of: one that hangs, or leaves a helper behind, is stopped. Never throws.
    async close() {
      for (const state of states) remember(state);
      await Promise.race([close(value).catch(() => {}), sleep(CLOSE_TIMEOUT_MS)]);
      await Promise.all(states.map((state) => stop(state, CLOSE_GRACE_MS)));
    },
  };
}

/** Stops every browser recorded by a weblab that is no longer running, all at once. */
async function sweepBrowsers(): Promise<void> {
  await Promise.all(recordNames("browser.").map(async (name) => {
    const state = readRecord<BrowserState>(name);
    if (state?.owner === undefined) {
      clearRecord(name);
      return;
    }
    // An owner whose start couldn't be read when it wrote the record is given the benefit of the doubt.
    if (state.owner.startedAt === null ? alive(state.owner.pid) : isProcess(state.owner.pid, state.owner.startedAt)) return;
    await stop(state, 0);
  }));
}

/**
 * Stops whatever weblabs that are gone left: their browsers, and servers
 * no live weblab uses. Run when a weblab starts, and by its watcher when
 * it has ended.
 */
export async function sweep(): Promise<void> {
  await sweepBrowsers().catch(() => {});
  await sweepServers().catch(() => {});
}

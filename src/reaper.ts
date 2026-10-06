// What weblab starts is weblab's to stop, however weblab ends.
//
// Ending a session, the client going, or a signal: the session's
// teardown closes its browser and lets go of its server, and makes sure
// both have gone. Killed outright, weblab can do nothing, so what it
// owns is recorded where another process can find it:
//
//   browser.<pid>.json  a browser weblab launched: its pid (it leads a
//                       process group, its helpers' too), when it
//                       started, and which weblab owns it
//   server.<...>.json   a server weblab started, and who is using it (server.ts)
//
// Whatever a weblab that is gone left recorded is stopped by its reaper
// (lifecycle.ts) the moment it goes, and failing that, by the next
// weblab to start. Only a recorded process still running as recorded (the
// same pid, started at the same time) is stopped, so a recycled pid, a
// browser weblab only attached to, or another weblab's (in any checkout)
// is never touched. A server another live weblab still uses stays up.
import { setTimeout as sleep } from "node:timers/promises";
import { watchOver } from "./lifecycle.ts";
import { departedProcess, groupLeadersStartedBy, isProcess, killGroup, startTime } from "./processes.ts";
import { sweepServers } from "./server.ts";
import { clearRecord, readRecord, recordNames, writeRecord } from "./state.ts";

type Owner = { pid: number; startedAt: string | null };
type BrowserState = { pid: number; startedAt: string | null; owner: Owner };

const recordName = (pid: number) => `browser.${pid}`;

// Playwright starts a browser in a process group of its own, talking to
// it over a pipe whose flag is on its command line.
const DRIVEN = /\s(--remote-debugging-pipe|-juggler-pipe|--inspector-pipe)(\s|$)/;
const browsersStarted = () => groupLeadersStartedBy(process.pid).filter((child) => DRIVEN.test(child.command)).map((child) => child.pid);

const CLOSE_GRACE_MS = 3000;

// The browser is still the one recorded: the same pid, started at the
// same time. Its helpers exit by themselves once it has gone, and a pid
// given out again since (after a reboot, say) is never signalled.
const remains = (state: BrowserState) => isProcess(state.pid, state.startedAt);

// Stopped if it hasn't gone by itself, and forgotten.
async function stop(state: BrowserState, graceMs: number): Promise<void> {
  for (let waited = 0; waited < graceMs && remains(state); waited += 100) await sleep(100);
  if (remains(state)) await killGroup(state.pid);
  clearRecord(recordName(state.pid));
}

export type OwnedBrowser = {
  /** After the browser was asked to close: waits for it to go, stops it if it doesn't, and forgets it. */
  release(): Promise<void>;
};

// One launch at a time in this process, so each knows which browser is its.
let launches: Promise<unknown> = Promise.resolve();

/**
 * Launches a browser as weblab's own. It is recorded as soon as it
 * appears, before Playwright has even finished with it, so a weblab
 * killed mid-launch leaves it to the reaper too. A launch that fails
 * stops whatever it started.
 */
export function ownBrowser<T>(launch: () => Promise<T>): Promise<{ value: T; owned: OwnedBrowser }> {
  const turn = launches.then(() => tracked(launch));
  launches = turn.catch(() => {});
  return turn;
}

async function tracked<T>(launch: () => Promise<T>): Promise<{ value: T; owned: OwnedBrowser }> {
  watchOver();
  const before = new Set(browsersStarted());
  const owner: Owner = { pid: process.pid, startedAt: startTime(process.pid) };
  const found = new Map<number, BrowserState>();
  const look = () => {
    for (const pid of browsersStarted()) {
      if (before.has(pid) || found.has(pid)) continue;
      const state = { pid, startedAt: startTime(pid), owner };
      found.set(pid, state);
      writeRecord(recordName(pid), state);
    }
  };
  let launching = true;
  const watching = (async () => {
    while (launching) {
      look();
      await sleep(50);
    }
  })();
  const owned: OwnedBrowser = {
    release: async () => {
      await Promise.all([...found.values()].map((state) => stop(state, CLOSE_GRACE_MS)));
    },
  };
  try {
    const value = await launch();
    return { value, owned };
  } catch (error) {
    launching = false;
    await watching;
    look();
    await Promise.all([...found.values()].map((state) => stop(state, 0)));
    throw error;
  } finally {
    launching = false;
    await watching;
    look();
  }
}

/** Stops every browser recorded by a weblab that is no longer running. */
async function sweepBrowsers(): Promise<void> {
  for (const name of recordNames("browser.")) {
    const state = readRecord<BrowserState>(name);
    if (state === null) {
      clearRecord(name);
      continue;
    }
    if (isProcess(state.owner.pid, state.owner.startedAt)) continue;
    await stop(state, 0);
  }
}

/** Stops whatever weblabs that are gone left: their browsers, and servers no live weblab uses. */
export async function sweep(): Promise<void> {
  await sweepBrowsers().catch(() => {});
  await sweepServers().catch(() => {});
}

/**
 * The reaper: waits for the weblab that started it to end, whichever way
 * it does (its pipe closes), and sweeps up after it.
 */
export async function reap(owner: number): Promise<void> {
  const startedAt = startTime(owner);
  await new Promise<void>((done) => {
    process.stdin.on("end", done);
    process.stdin.on("close", done);
    process.stdin.on("error", () => done());
    process.stdin.resume();
  });
  // Ended, though its parent may not have collected it yet.
  departedProcess(owner, startedAt);
  await sweep();
}

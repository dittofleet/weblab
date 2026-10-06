// The servers sessions point at. A server is its address: whatever
// answers there is used as it is, and when nothing does, weblab starts
// the command it was given (or the project's dev script) and waits for
// the address to answer. A server weblab started is shared by every
// session pointing at it, in any weblab process, and stopped when the
// last of them ends.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join as joinPath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dependenciesMissing, devCommand, projectOrigin, SERVER_TIMEOUT_MS } from "./app.ts";
import { SetupError, stripAnsi, tail } from "./errors.ts";
import { onTeardown } from "./lifecycle.ts";
import { allListeners, cwdOf, groupMembers, groupOf, isProcess, killGroup, killProcess, listenersOn, membersOf, type Process, processOf, running, startedAtMs, startTime } from "./processes.ts";
import { acquireLock, clearRecord, fileName, readRecord, recordNames, writeRecord } from "./state.ts";
import type { App } from "./types.ts";

/** A server weblab started, recorded under its address so every weblab process sees it. */
type ServerState = {
  pgid: number;
  /** The leader's start time, so a recycled pid is never mistaken for ours. */
  startedAt: string | null;
  /** When weblab spawned it: a process that started earlier can't be its. */
  spawnedAt?: number;
  /** What was listening already when weblab spawned it, so can't be its. */
  listeningBefore?: number[];
  /** Every process in the group when the server first answered, so a group whose leader has gone can still be told apart. */
  members?: { pid: number; startedAt: string | null }[];
  origin: string | null;
  /** What was run, where, and where its output went. */
  command: string;
  root: string;
  log: string;
  /** True when nobody said where it would answer: the address is the one it printed. */
  auto: boolean;
  /** The weblab processes with a session on it now. The last to leave stops it. */
  users: User[];
  /**
   * A server that put itself in the background (`astro dev` does): the
   * process listening on the port, which left weblab's group. Found
   * when the server first answered. Its group is stopped only if it
   * leads it (it called setsid); otherwise only the process is.
   */
  detached?: { pid: number; pgid: number; startedAt: string | null };
};

type User = Process;

/** What became of the server when a session was done with it. */
export type Fate = "stopped" | "shared" | "not-ours" | "gone";

export type Server = {
  origin: string;
  /** True when weblab started the server: this process, or one it shares it with. */
  owned: boolean;
  /** True when this very call started it. */
  started: boolean;
  /** The command that started it, when weblab did. */
  command?: string;
  /** Done with the server: stops it if it is weblab's and nothing else is using it. */
  stop(): Promise<Fate>;
};

/** What became of a server, as a line to print; nothing for one that had already gone. */
export function fateText(origin: string, fate: Fate): string | null {
  switch (fate) {
    case "stopped":
      return `stopped the server at ${origin}`;
    case "shared":
      return `left the server at ${origin} running: another session is using it, and the last one stops it`;
    case "not-ours":
      return `left the server at ${origin} running, as weblab didn't start it`;
    case "gone":
      return null;
  }
}

type Options = {
  /** Where it answers, as an origin, when the session said. */
  address?: string;
  /** How to start it, when the session said. */
  command?: string;
  timeoutMs?: number;
  /** Where its output goes, if weblab starts it. */
  logDir: string;
  log(line: string): void;
};

// One record per address. Every name for this machine is the same place.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/;
const recordName = (origin: string) => {
  const { hostname, port, protocol } = new URL(origin);
  return `server.${fileName(`${LOCAL.test(hostname) ? "local" : hostname}-${port || (protocol === "https:" ? "443" : "80")}`)}`;
};
const readState = (name: string) => readRecord<ServerState>(name);

// Starting, joining and leaving a server each happen under its lock, so
// two sessions never start the same one twice or stop it under each other.
const locked = (name: string, log: (line: string) => void) =>
  acquireLock(name, { busy: () => null, waiting: (holder) => log(`waiting for another weblab (pid ${holder}) that is starting this server`) });

// A process that started after weblab spawned the server.
// Start times are kept to the second, so "after" is the spawn's second or later.
const startedSince = (pid: number, spawnedAt: number | undefined) => {
  const started = startedAtMs(pid);
  return spawnedAt !== undefined && started !== null && started >= Math.floor(spawnedAt / 1000) * 1000;
};

// The group weblab started is still its own: its leader is the very
// process spawned, or, with the leader gone (and its pid not reused),
// everything left in the group is a process recorded in it when the
// server answered. Anything else is let be: leaving a stray process is
// better than signalling another agent's.
function groupIsOurs(state: ServerState): boolean {
  if (isProcess(state.pgid, state.startedAt)) return true;
  if (running(state.pgid) || state.members === undefined) return false;
  const recorded = state.members;
  const members = groupMembers(state.pgid);
  return members.length > 0 && members.every((pid) => recorded.some((member) => member.pid === pid && isProcess(pid, member.startedAt)));
}

const recordMembers = (state: ServerState) => {
  state.members = membersOf(state.pgid);
};

const me = (): User => processOf(process.pid);
const usersOf = (state: ServerState): User[] => (state.users ?? []).filter((user) => isProcess(user.pid, user.startedAt));
const othersUsing = (state: ServerState): User[] => usersOf(state).filter((user) => user.pid !== process.pid);

const detachedIsOurs = ({ detached }: ServerState) => detached !== undefined && isProcess(detached.pid, detached.startedAt);

// Something of the server's is still running: the group, or the process it moved out of it.
const serverIsOurs = (state: ServerState) => groupIsOurs(state) || detachedIsOurs(state);

// Everything that is ours to stop, and nothing that isn't.
async function stopServer(state: ServerState): Promise<void> {
  if (groupIsOurs(state)) await killGroup(state.pgid);
  const { detached } = state;
  if (detached === undefined || !detachedIsOurs(state)) return;
  if (detached.pgid === detached.pid) await killGroup(detached.pgid);
  else await killProcess(detached.pid);
}

/**
 * Whose server answers at an origin, judged by what listens on its
 * port. weblab's, if a listener is in the group it started. weblab's,
 * gone into the background (as `astro dev` goes), only if the command
 * weblab ran has exited cleanly, and the listener wasn't listening
 * before, started since, and works in the project's own directory: two
 * agents' servers starting at once can't be told apart by time alone.
 * Someone else's otherwise. Without lsof to ask, it is taken to be
 * weblab's, as nothing answered before weblab started it.
 */
function whoseServer(state: ServerState, origin: string, wentToBackground: boolean): { ours: false } | { ours: true; detached?: ServerState["detached"] } {
  const port = Number(new URL(origin).port);
  const listeners = port ? listenersOn(port) : [];
  if (listeners.length === 0 || listeners.some((pid) => groupOf(pid) === state.pgid)) return { ours: true };
  if (!wentToBackground) return { ours: false };
  const before = new Set(state.listeningBefore ?? []);
  const root = realpathSync(state.root);
  const inProject = (pid: number) => {
    const cwd = cwdOf(pid);
    return cwd !== null && (cwd === root || cwd.startsWith(`${root}/`));
  };
  const moved = listeners.find((pid) => !before.has(pid) && startedSince(pid, state.spawnedAt) && inProject(pid));
  const pgid = moved === undefined ? null : groupOf(moved);
  if (moved === undefined || pgid === null) return { ours: false };
  return { ours: true, detached: { pid: moved, pgid, startedAt: startTime(moved) } };
}

export async function probe(origin: string, timeoutMs = 1500): Promise<boolean> {
  try {
    // Any HTTP answer counts: a dev server that 404s on / is still up.
    await fetch(origin, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

const DETACHED_PATIENCE_MS = 15_000;

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/g;

function urlsInLog(log: string): string[] {
  try {
    return [...new Set(stripAnsi(readFileSync(log, "utf8")).match(LOCAL_URL) ?? [])];
  } catch {
    return [];
  }
}

// A server other sessions are using may be slow to answer while it builds.
const SHARED_PATIENCE_MS = 15_000;

const notOurs = (origin: string): Server => ({ origin, owned: false, started: false, stop: async () => "not-ours" });

/**
 * The server a session points at, started if need be.
 * - At an address the session gave: whatever answers there is used,
 *   and if nothing does, the command is started and told the port
 *   (PORT in its environment).
 * - With no address given, the project's own: where its .env says
 *   (PORT), else wherever its dev script says it is listening. One
 *   weblab already started for the project is joined, else one is started.
 */
export async function ensureServer(app: App, options: Options): Promise<Server> {
  const command = options.command ?? devCommand(app);
  if (options.address !== undefined) return atAddress(app, options.address, command, options);
  return ofProject(app, command, options);
}

type Held = { server: Server; count: number };
const inUse = new Map<string, Promise<Held>>();

// One more session, in this process, on a server it already holds.
function another(name: string, held: Held): Server {
  held.count += 1;
  const first = held.count === 1;
  let left: Promise<Fate> | null = null;
  return {
    ...held.server,
    started: first && held.server.started,
    stop: () =>
      (left ??= (async () => {
        if ((held.count -= 1) > 0) return "shared";
        inUse.delete(name);
        return held.server.stop();
      })()),
  };
}

// Sessions of this process on one server are counted here, and the
// record only says the process is using it.
async function counted(name: string, take: () => Promise<Server>): Promise<Server> {
  const holding = inUse.get(name);
  if (holding !== undefined) {
    const now = await holding.catch(() => null);
    if (now !== null && now.count > 0) return another(name, now);
  }
  const taking = take().then((server) => ({ server, count: 0 }));
  inUse.set(name, taking);
  try {
    const now = await taking;
    // One that isn't weblab's is nobody's to count.
    if (!now.server.owned) {
      inUse.delete(name);
      return now.server;
    }
    return another(name, now);
  } catch (error) {
    inUse.delete(name);
    throw error;
  }
}

function atAddress(app: App, origin: string, command: string | null, options: Options): Promise<Server> {
  const name = recordName(origin);
  return counted(name, async () => {
    const release = await locked(name, options.log);
    // An interrupt while the server starts lets go of it too.
    onTeardown(release);
    try {
      const joined = await joinRecorded(name, options.log);
      if (joined !== null) return joined;
      // Someone else's, already there: used as it is.
      if (await probe(origin)) return notOurs(origin);
      if (command === null) {
        throw new SetupError(`nothing answers at ${origin}, and ${app.root} has no dev script to start: give start, the command that starts it`);
      }
      return await startServer(app, command, origin, options);
    } finally {
      release();
    }
  });
}

// A server weblab started before, still recorded at this address: one
// other sessions are using, or one an interrupted weblab left behind.
async function joinRecorded(name: string, log: (line: string) => void): Promise<Server | null> {
  const previous = readState(name);
  if (previous === null) return null;
  const others = othersUsing(previous);
  let answers = serverIsOurs(previous) && previous.origin !== null && (await probe(previous.origin));
  for (const deadline = Date.now() + SHARED_PATIENCE_MS; !answers && others.length > 0 && serverIsOurs(previous) && previous.origin !== null && Date.now() < deadline; ) {
    await sleep(500);
    answers = await probe(previous.origin);
  }
  if (answers) {
    if (usersOf(previous).length === 0) log(`adopting the server an interrupted weblab left at ${previous.origin}`);
    previous.users = [...others, me()];
    writeRecord(name, previous);
    return owned(name, previous, false, log);
  }
  if (serverIsOurs(previous) && others.length > 0) {
    throw new SetupError(`weblab's server at ${previous.origin} isn't answering, and another weblab (pid ${others[0]?.pid}) is using it; see ${previous.log}`);
  }
  if (serverIsOurs(previous)) await stopServer(previous);
  clearRecord(name);
  return null;
}

async function ofProject(app: App, command: string | null, options: Options): Promise<Server> {
  const starting = `start.${createHash("sha1").update(`${app.root}\n${command ?? ""}`).digest("hex").slice(0, 12)}`;
  // One at a time for a project's command, so two sessions opened
  // together share one server rather than starting two.
  const release = await locked(starting, options.log);
  onTeardown(release);
  try {
    // Where its .env says, if something is there: weblab's own, or someone else's.
    const said = projectOrigin(app);
    if (said !== null && (readState(recordName(said)) !== null || (await probe(said)))) {
      const there = await atAddress(app, said, null, options).catch(() => null);
      if (there !== null) return there;
    }
    // One weblab started for this project before, wherever it turned out to answer.
    for (const name of recordNames("server.")) {
      const state = readState(name);
      if (state === null || !state.auto || state.root !== app.root || state.command !== command || state.origin === null || !serverIsOurs(state)) continue;
      // Joined under its own lock, as any server is.
      return await atAddress(app, state.origin, command, options);
    }
    if (command === null) {
      throw new SetupError(
        said === null
          ? `no address is known for ${app.root}, and it has no dev script to start: give address (and start, if nothing is running there yet)`
          : `nothing answers at ${said} (the PORT in ${app.root}/.env), and the project has no dev script to start: give start, the command that starts it`,
      );
    }
    // Where its .env says it will answer is held while it starts, so a
    // session asking for that address by name waits and then joins it.
    const expected = said === null ? null : recordName(said);
    const releaseExpected = expected === null ? null : await locked(expected, options.log);
    if (releaseExpected !== null) onTeardown(releaseExpected);
    try {
      const started = await startServer(app, command, null, options, expected);
      return await counted(recordName(started.origin), async () => started);
    } finally {
      releaseExpected?.();
    }
  } finally {
    release();
  }
}

let startCount = 0;

// `holding` is the record whose lock the caller has: the one a server
// at a known address is written under.
async function startServer(app: App, command: string, wanted: string | null, options: Options, holding: string | null = wanted === null ? null : recordName(wanted)): Promise<Server> {
  mkdirSync(options.logDir, { recursive: true });
  const count = (startCount += 1);
  const logFile = joinPath(options.logDir, `server-${fileName(wanted === null ? `${process.pid}-${count}` : new URL(wanted).host)}.log`);
  const out = openSync(logFile, "a");
  // Its own process group, so teardown reaches vite under the
  // package-manager wrapper, not just the wrapper.
  const listeningBefore = [...allListeners()];
  const spawnedAt = Date.now();
  const port = wanted === null ? "" : new URL(wanted).port;
  const child = spawn(command, {
    cwd: app.root,
    shell: true,
    detached: true,
    stdio: ["ignore", out, out],
    // Told where to answer, the way most dev servers read it.
    env: { ...process.env, ...(port === "" ? {} : { PORT: port }) },
  });
  closeSync(out);
  if (child.pid === undefined) throw new SetupError(`could not start: ${command}`);
  child.unref();
  let exitCode: number | null = null;
  let exitedAt = 0;
  child.on("exit", (code) => {
    exitCode = code ?? 1;
    exitedAt = Date.now();
  });

  const state: ServerState = {
    pgid: child.pid,
    startedAt: startTime(child.pid),
    spawnedAt,
    listeningBefore,
    origin: null,
    command,
    root: app.root,
    log: logFile,
    auto: wanted === null,
    users: [me()],
  };
  // Recorded from the start, so a weblab that dies while it waits
  // leaves something for the next one to clear away.
  let name = wanted === null ? `server.starting-${process.pid}-${count}` : recordName(wanted);
  writeRecord(name, state);
  // Until the server answers and is handed to the session, an
  // interrupt has to stop it from here.
  let handedOver = false;
  const giveUp = async () => {
    handedOver = true;
    await killGroup(state.pgid);
    // Only its own record: another server may have been recorded there since.
    const now = readState(name);
    if (now !== null && sameServer(now, state)) clearRecord(name);
  };
  onTeardown(async () => {
    if (!handedOver) await giveUp();
  });

  const timeoutMs = options.timeoutMs ?? SERVER_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A project's own server says where it answers as it starts: in its
    // .env (the dev command may be what writes it), or in what it prints.
    const said = wanted === null ? projectOrigin(app) : null;
    for (const origin of wanted !== null ? [wanted] : [...(said === null ? [] : [said]), ...urlsInLog(logFile)]) {
      if (!(await probe(origin))) continue;
      // An address in the log may be another app's (an API it calls),
      // already served by someone else: only weblab's own server counts.
      const whose = whoseServer(state, origin, exitCode === 0);
      if (!whose.ours) continue;
      state.origin = origin;
      recordMembers(state);
      if (whose.detached !== undefined) {
        state.detached = whose.detached;
        options.log(`the server went into the background (pid ${whose.detached.pid}); weblab is keeping track of it`);
      }
      // Recorded under its address, under that address's lock: a session
      // joining or leaving there at this moment sees one or the other.
      const starting = name;
      const found = recordName(origin);
      const release = found === holding ? null : await locked(found, options.log);
      try {
        name = found;
        writeRecord(name, state);
        if (starting !== name) clearRecord(starting);
        handedOver = true;
      } finally {
        release?.();
      }
      return owned(name, state, true, options.log);
    }
    // A clean exit may be a server that went into the background, which
    // gets a while to come up; any other exit is a server that failed.
    if (exitCode !== null && (exitCode !== 0 || Date.now() - exitedAt > DETACHED_PATIENCE_MS)) {
      // The wrapper is gone, but something it started may not be.
      await giveUp();
      const why = dependenciesMissing(app) ? ` (${app.root} has no node_modules: install its dependencies first)` : "";
      throw new SetupError(`the server exited with code ${exitCode} before answering${exitCode === 0 ? ` (and nothing answered for ${DETACHED_PATIENCE_MS / 1000} s after)` : ""}${why}; see ${logFile}${tail(logFile)}`);
    }
    await sleep(250);
  }
  await giveUp();
  const where = wanted === null ? "at the PORT in its .env, or at any address its output printed" : `at ${wanted} (it was started with PORT=${port}; if it takes its port another way, say so in start)`;
  throw new SetupError(`the server did not answer ${where} within ${timeoutMs} ms; see ${logFile}${tail(logFile)}`);
}

// The same server as a record names: not one started since in its place.
const sameServer = (a: ServerState, b: ServerState) => a.pgid === b.pgid && a.startedAt === b.startedAt;

function owned(name: string, state: ServerState, started: boolean, log: (line: string) => void): Server {
  const leave = async (): Promise<Fate> => {
    const release = await locked(name, log);
    try {
      const now = readState(name);
      // Stopped already, or replaced.
      if (now === null || !sameServer(now, state)) return "gone";
      // A session of this process took it again while this waited its turn.
      if (inUse.has(name)) return "shared";
      now.users = othersUsing(now);
      if (now.users.length > 0) {
        writeRecord(name, now);
        return "shared";
      }
      await stopServer(now);
      clearRecord(name);
      return "stopped";
    } finally {
      release();
    }
  };
  // Left once: a second call (an interrupt while the first is under way) waits for the same one.
  let leaving: Promise<Fate> | null = null;
  return {
    origin: state.origin as string,
    owned: true,
    started,
    command: state.command,
    stop: () => (leaving ??= leave()),
  };
}

/**
 * Stops every server weblab started that no live weblab is using: what
 * one that was killed left behind. Run when a weblab starts.
 */
export async function sweepServers(): Promise<void> {
  for (const name of recordNames("server.")) {
    // One that is being started or joined right now is someone's.
    const release = await acquireLock(name, { busy: () => "in use" }).catch(() => null);
    if (release === null) continue;
    try {
      const state = readState(name);
      if (state === null || usersOf(state).length > 0) continue;
      if (serverIsOurs(state)) await stopServer(state);
      clearRecord(name);
    } finally {
      release();
    }
  }
}

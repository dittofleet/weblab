// Sessions: every browser this weblab has open, by name, and the steps
// run on them.
//
// A session is a browser of its own (its cookies, its tabs) pointing at
// an address. Any number can be open, and each is opened and ended on
// its own. Steps go to the session a run names; a step says another
// with `on`. A step can open a session too (`new`), which is the same
// as any other and stays until it is ended.
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type CDPSession, type Page } from "playwright-core";
import { originOf, resolveApp } from "./app.ts";
import { browserProcess, createBrowserManager, DEFAULT_VIEWPORT, otherEngine, type BrowserManager } from "./browser.ts";
import { withoutCursor } from "./cursor.ts";
import { joinMainProcess, type MainProcess } from "./electron.ts";
import { SetupError, StepFailure, stepError, UsageError } from "./errors.ts";
import { filming } from "./film.ts";
import { registerComponents, unwatchReact, usesReact, watchReact } from "./react/watch.ts";
import { sourceMapper } from "./sources.ts";
import { record, type Recorder } from "./recorder.ts";
import { actionOf, checkTimeout, stepBase, stepOrigin } from "./script.ts";
import { keepDisplayAwake, TRACK_PAGE_ON_SCREEN } from "./screen.ts";
import { ensureServer, fateText, type Server } from "./server.ts";
import { artifactsDir, holdProfile, signInPath, slug } from "./state.ts";
import { builtinActions, checkOptions } from "./steps/index.ts";
import { SESSION_KEYS } from "./steps/sessions.ts";
import { locate } from "./steps/target.ts";
import type { ActionContext, App, SessionHandle, SessionOptions, Settings, Step, StepResult } from "./types.ts";
import { escapeRegExp, nearest, viewportSize } from "./util.ts";

const DEFAULT_STEP_TIMEOUT = 10_000;

// What a step on a session whose app quit or restarted says.
const GONE = "the app this session is attached to went away: it quit or restarted. End the session and open it again";

/** The name a session gets when none is given and none is open yet. */
export const MAIN = "main";

/** One call's worth of steps: what they are given, and what they leave. */
export type Job = {
  /** The session steps go to when they don't say. */
  on: string;
  params: Record<string, unknown>;
  /** The time for each step that sets none of its own. */
  timeout?: number;
  steps: StepResult[];
  shots: string[];
  /** Other files the steps wrote: downloads, text snapshots, videos. */
  files: string[];
  /** Things worth saying that belong to no one step: a server started, a session ended. */
  lines: string[];
};

export const newJob = (on: string, given: Partial<Pick<Job, "params" | "timeout">> = {}): Job => ({
  on,
  params: given.params ?? {},
  timeout: given.timeout,
  steps: [],
  shots: [],
  files: [],
  lines: [],
});

/** What a session left when it ended. */
export type Ended = { name: string; dir: string; videos?: string[]; trace?: string; server?: string };

export type Session = {
  name: string;
  ctx: ActionContext;
  app: App;
  /** Where it was pointed, when it was pointed anywhere: an attached browser may just be where it is. */
  address: string | null;
  /** The path its address was given with, if any: where it goes first. */
  firstPath?: string;
  server: Server | null;
  attached: boolean;
  /** True when the running app it is attached to has quit or restarted: it can only be ended. */
  gone(): boolean;
  headed: boolean;
  /** Where its files go. */
  dir: string;
  consoleLog: string;
  networkLog: string;
  /** What the page logged since this was last asked. */
  consoleSinceLast(): string[];
  /** Where it was, and which tabs it had, when a reply last said. */
  shown: string;
  shownTabs: string;
};

type Driver = Session & {
  recorder: Recorder;
  /** What a step on it gets when neither it nor its run sets a time. */
  timeout: number;
  /** How it was opened, for a session a step opens from it. */
  options: SessionOptions;
  failed: boolean;
  finish(): Promise<Ended>;
};

const drivers = new Map<string, Driver>();
// Names being opened, and how often each has been: a name used again gets files of its own.
const opening = new Set<string>();
const opened = new Map<string, number>();

// The job a step belongs to, and the step running now: what a note
// belongs to, what code's own `step()` calls are recorded under, and
// where its files are read from. Kept per async call chain, so steps
// run side by side stay apart.
const jobs = new AsyncLocalStorage<Job>();
const running = new AsyncLocalStorage<StepResult>();
const bases = new WeakMap<StepResult, string | undefined>();
// The session each running step is on, and the time it has, for code's steps to return to.
const ran = new WeakMap<StepResult, { driver: Driver; timeout: number }>();
// The step an error came from, so a failure inside code is reported as that step.
const failedIn = new WeakMap<object, StepResult>();

const say = (line: string) => {
  const job = jobs.getStore();
  if (job === undefined) console.error(line);
  else job.lines.push(line);
};

/** Runs something as part of a job: what it captures and says lands there. */
export const within = <T>(job: Job, work: () => Promise<T>): Promise<T> => jobs.run(job, work);

export const names = (): string[] => [...drivers.keys()];
export const has = (name: string): boolean => drivers.has(name);

function pick(on: string): Driver {
  const driver = drivers.get(on);
  if (driver !== undefined) return driver;
  const open = names();
  const guess = nearest(on, open);
  throw new UsageError(`no session "${on}" is open${guess === undefined ? "" : ` (did you mean "${guess}"?)`}; open: ${open.join(", ") || "none"}. Open one with new.`);
}

export const session = (name: string): Session => pick(name);

// The directory sessions write to when they aren't given one: made
// when the first session opens, and named after its project.
let sharedDir: string | null = null;

// Sessions launched the same way share one browser, each in a context
// of its own; it closes when the last of them ends.
const launched = new Map<string, { manager: BrowserManager; count: number }>();
const launchKey = (settings: Settings, headed: boolean) => JSON.stringify([settings.browser ?? "chrome", settings.browserArgs ?? [], headed]);

function takeBrowser(app: App, headed: boolean): { browser: BrowserManager; release(): Promise<void> } {
  const { settings } = app;
  // A browser that is joined, or one with a kept profile, is that session's alone.
  if (settings.attach !== undefined || settings.persist) {
    const browser = createBrowserManager(app, { headed: headed && settings.attach === undefined });
    return { browser, release: () => browser.close() };
  }
  const key = launchKey(settings, headed);
  let shared = launched.get(key);
  if (shared === undefined) launched.set(key, (shared = { manager: createBrowserManager(app, { headed }), count: 0 }));
  shared.count += 1;
  const mine = shared;
  return {
    browser: mine.manager,
    async release() {
      if ((mine.count -= 1) > 0) return;
      if (launched.get(key) === mine) launched.delete(key);
      await mine.manager.close();
    },
  };
}

// `URL.origin` is "null" for an app's own scheme (an Electron app's
// `myapp://`), where scheme and host still make a base to resolve from.
function originOfUrl(url: string): string {
  try {
    const { protocol, host } = new URL(url);
    return host === "" ? "" : `${protocol}//${host}`;
  } catch {
    return "";
  }
}

/** Reads what a log gained since the last call, a line at a time; never the whole file again. */
function follow(file: string): () => string[] {
  let offset = 0;
  return () => {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return [];
      const fresh = Buffer.alloc(size - offset);
      readSync(fd, fresh, 0, fresh.length, offset);
      offset = size;
      return fresh.toString("utf8").split("\n").filter((line) => line !== "");
    } finally {
      closeSync(fd);
    }
  };
}

// The path an address was written with: "http://localhost:3000/app" goes to /app first.
function addressPath(address: string | number | undefined): string | undefined {
  if (typeof address !== "string" || !/^[a-z][a-z\d+.-]*:\/\//i.test(address)) return undefined;
  try {
    const { pathname, search, hash } = new URL(address);
    return `${pathname}${search}${hash}` === "/" ? undefined : `${pathname}${search}${hash}`;
  } catch {
    return undefined;
  }
}

// Context options that say who a session is, which a session opened from it doesn't take.
const IDENTITY = ["storageState", "httpCredentials", "extraHTTPHeaders"];

// What a session a step opens takes from the one the step is on: how
// it is driven, and where. Never who it is (a saved sign-in, a kept
// profile), nor which running browser it joined.
function inherited(parent: Driver): SessionOptions {
  const { name: _name, attach: _attach, tab: _tab, newTab: _newTab, mainProcess: _mainProcess, persist: _persist, state: _state, path: _path, address: _address, context, ...rest } = parent.options;
  return {
    ...rest,
    ...(context === undefined ? {} : { context: Object.fromEntries(Object.entries(context).filter(([key]) => !IDENTITY.includes(key))) }),
    dir: parent.app.root,
    out: parent.dir,
    // Where the parent is pointed: its server, or the site an attached browser is on.
    ...(parent.address !== null ? { address: parent.address } : /^https?:/.test(parent.ctx.origin) ? { address: parent.ctx.origin } : {}),
  };
}

function checked(options: SessionOptions): SessionOptions {
  const unknown = Object.keys(options).find((key) => !SESSION_KEYS.includes(key));
  // Recording was once an option here, and is a step now, so it can start once the app has loaded.
  if (unknown === "video") throw new UsageError(`new: no option "video". Record with the video step once the session is open: { "video": "start" }, then { "video": "stop" }`);
  if (unknown !== undefined) {
    const guess = nearest(unknown, SESSION_KEYS);
    throw new UsageError(`new: no option "${unknown}"${guess === undefined ? "" : ` (did you mean "${guess}"?)`}; it takes ${SESSION_KEYS.join(", ")}`);
  }
  if (options.attach === undefined && (options.tab !== undefined || options.newTab)) {
    throw new UsageError("new: tab and newTab say what to drive in a running browser; they need attach");
  }
  if (options.attach === undefined && options.mainProcess !== undefined) {
    throw new UsageError("new: mainProcess joins the main process of an Electron app the session is attached to, so it needs attach, the app's Chromium debugging port");
  }
  const launchOnly = (["browser", "browserArgs", "persist", "state", "context", "headed"] as const).filter((key) => options[key] !== undefined && options[key] !== false);
  if (options.attach !== undefined && launchOnly.length > 0) {
    throw new UsageError(`new: ${launchOnly.join(", ")} can't be used with attach: that browser is already running as it is`);
  }
  checkTimeout(options.timeout, "new");
  checkTimeout(options.startTimeout, "new: startTimeout");
  return options;
}

/** Where a session goes first: the path it was given, else the app's front page. One that joined a browser stays where it is. */
export const firstPath = (opened: Session, path: string | undefined): string | undefined => path ?? opened.firstPath ?? (opened.attached ? undefined : "/");

// Sessions being opened right now, so leaving waits for them and ends them too.
const arriving = new Set<Promise<unknown>>();
let leaving = false;

/** Opens a session. `parent` is the session a `new` step ran on, whose way of being driven it takes. */
export function open(given: SessionOptions, parent?: Driver): Promise<Session> {
  if (leaving) return Promise.reject(new SetupError("weblab is exiting"));
  const opened = opening_(given, parent);
  arriving.add(opened);
  const settle = () => void arriving.delete(opened);
  opened.then(settle, settle);
  return opened;
}

async function opening_(given: SessionOptions, parent?: Driver): Promise<Session> {
  checked(given);
  let name = given.name;
  if (name === undefined && !drivers.has(MAIN) && !opening.has(MAIN)) name = MAIN;
  for (let count = 2; name === undefined; count += 1) if (!drivers.has(`session${count}`) && !opening.has(`session${count}`)) name = `session${count}`;
  if (!/^[\w.-]{1,32}$/.test(name)) throw new UsageError(`a session's name is short: letters, digits, dots, dashes and underscores, not ${JSON.stringify(name)}`);
  if (drivers.has(name) || opening.has(name)) throw new UsageError(`a session named "${name}" is already open; end it first, or give this one another name`);
  // Taken at once, so two opened at the same moment can't share a name.
  opening.add(name);
  try {
    // A browser weblab joins is as it is: it takes nothing from the parent but where files go.
    const base = parent === undefined ? {} : given.attach !== undefined ? { dir: parent.app.root, out: parent.dir } : inherited(parent);
    return await openNamed(name, { ...base, ...given, context: given.attach !== undefined ? undefined : { ...base.context, ...given.context }, name });
  } finally {
    opening.delete(name);
  }
}

async function openNamed(name: string, options: SessionOptions): Promise<Driver> {
  const viewport = typeof options.viewport === "string" ? viewportSize(options.viewport) : options.viewport;
  if (viewport === null) throw new UsageError(`new: viewport looks like "390x844@3" or { width, height, deviceScaleFactor }`);
  const settings: Settings = {
    ...(options.ready === undefined ? {} : { ready: options.ready }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(options.context === undefined || Object.keys(options.context).length === 0 ? {} : { context: options.context }),
    ...(options.browserArgs === undefined ? {} : { browserArgs: options.browserArgs }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
    ...(options.browser === undefined ? {} : { browser: options.browser }),
    ...(options.attach === undefined ? {} : { attach: String(options.attach) }),
    ...(options.tab === undefined ? {} : { tab: options.tab }),
    ...(options.newTab ? { newTab: true } : {}),
    ...(options.mainProcess === undefined ? {} : { mainProcess: String(options.mainProcess) }),
    ...(options.persist ? { persist: true } : {}),
    ...(options.init === undefined ? {} : { init: [options.init].flat() }),
  };
  const app = resolveApp(options.dir, settings);
  const dir = options.out !== undefined ? artifactsDir(app.label, options.out) : (sharedDir ??= artifactsDir(app.label, undefined));

  const times = (opened.get(name) ?? 0) + 1;
  opened.set(name, times);
  // A name used again, after its session ended, doesn't write over what that one left.
  const files = `${slug(name)}${times === 1 ? "" : `-${times}`}`;
  const logPath = (kind: string, extension: string) => {
    mkdirSync(join(dir, kind), { recursive: true });
    return join(dir, kind, `${files}.${extension}`);
  };
  const consoleLog = logPath("console", "log");
  const networkLog = logPath("network", "log");

  const state = settings.state;
  if (state !== undefined && !existsSync(signInPath(app, state))) {
    throw new SetupError(`no saved state named "${state}" for ${app.root}; a saveState step saves one`);
  }

  // What has to be undone if the session can't be opened, or when it ends.
  const undo: (() => Promise<unknown> | unknown)[] = [];
  const unwind = async () => {
    for (const one of undo.reverse()) await Promise.resolve(one()).catch(() => {});
  };
  try {
    // Where it answers. A browser that is joined is already somewhere,
    // so a server is only this session's business when it names one.
    const address = options.address === undefined ? null : originOf(options.address);
    let server: Server | null = null;
    let left: string | undefined;
    if (settings.attach === undefined || address !== null || options.start !== undefined) {
      server = await ensureServer(app, { address: address ?? undefined, command: options.start, timeoutMs: options.startTimeout, logDir: dir, log: say });
      const using = server;
      if (using.started) say(`started the server at ${using.origin} (${using.command}); it stops when the last session on it ends`);
      // Let go of when the session ends; stopped if nothing else is using it.
      undo.push(async () => {
        left = fateText(using.origin, await using.stop()) ?? undefined;
      });
    }
    const origin = server?.origin ?? null;

    const headed = options.headed === true;
    if (settings.persist && settings.attach === undefined) undo.push(await holdProfile(app, settings.browser ?? "chrome"));
    const { browser, release } = takeBrowser(app, headed);
    undo.push(release);

    const size = { ...DEFAULT_VIEWPORT, ...settings.viewport };
    const { context, page: existing, close } = await browser.open({
      viewport: size,
      viewportGiven: settings.viewport !== undefined,
      scaleGiven: settings.viewport?.deviceScaleFactor !== undefined,
      settings: { ...settings.context, ...(state === undefined ? {} : { storageState: signInPath(app, state) }) },
    });
    undo.push(close);
    // A browser or app weblab joined keeps running: what weblab put into its pages comes out first.
    if (browser.attached) undo.push(() => unwatchReact(context));
    // A React project's pages are watched from the first, and any other's from its first react step.
    await registerComponents();
    if (usesReact(app.root)) await watchReact(context);
    // The session's own scripts, before any page's: what its pages expect to find already there.
    for (const file of settings.init ?? []) await context.addInitScript({ path: await resolveFile(file, app) });

    const tracing = settings.trace ?? false;
    if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });

    // What dialogs get, and which requests a mock answered: set up before
    // anything listens, since a dialog or response can come at any moment.
    const dialogs = { accept: false } as ActionContext["dialogs"];
    const mocked = new WeakSet<object>();
    const firstTab = existing ?? context.pages()[0] ?? (await context.newPage());
    const recorder = record(context, firstTab, {
      consoleLog,
      networkLog,
      ignore: settings.ignore ?? [],
      mocked,
      errors: { console: 0, page: 0, request: 0 },
      onDialog(dialog) {
        const { accept, text } = dialogs;
        recorder.note(`[dialog ${dialog.type()}] ${dialog.message()} (${accept ? "accepted" : "dismissed"})`);
        void (accept ? dialog.accept(text) : dialog.dismiss()).catch(() => {});
      },
    });
    undo.push(() => recorder.stop());
    // An Electron app's main process, when its debugger's port is given: joined now, so a wrong port is said at once.
    const main: MainProcess | null = settings.mainProcess === undefined ? null : await joinMainProcess(settings.mainProcess, `${name}-${process.pid}-${times}`, recorder.fromMain);
    if (main !== null) {
      undo.push(() => main.close());
      // The two ports are one app's: its windows' browser process is its main process.
      const windows = await browserProcess(context);
      if (windows !== null && windows !== main.pid) {
        throw new SetupError(`attach ${settings.attach} and mainProcess ${settings.mainProcess} are two different apps (processes ${windows} and ${main.pid}); give one app's two ports`);
      }
    }
    const film = filming(dir, files, say);
    if (browser.windowed) {
      // For captures of the real screen: see screen.ts.
      await context.addInitScript(TRACK_PAGE_ON_SCREEN);
      await firstTab.evaluate(TRACK_PAGE_ON_SCREEN).catch(() => {});
      await keepDisplayAwake();
    }

    const timeout = settings.timeout ?? DEFAULT_STEP_TIMEOUT;
    context.setDefaultTimeout(timeout);

    const cdpSessions = new WeakMap<Page, CDPSession>();
    const ctx: ActionContext = {
      name,
      page: firstTab,
      context,
      app,
      // An attached browser with no address given: wherever it already is.
      origin: origin ?? originOfUrl(firstTab.url()),
      dialogs,
      timeout,
      mocked,
      logs: recorder.logs,
      responses: recorder.responses,
      loads: () => recorder.loads(ctx.page),
      sinceLoad: () => recorder.sinceLoad(ctx.page),
      ignore: recorder.ignore,
      // Scripts and their maps, read as the page would (its cookies), or from disk for the main process's.
      sources: sourceMapper(async (url) => {
        const response = await context.request.get(url, { timeout: 5000 }).catch(() => null);
        if (response?.ok()) return response.text();
        return ctx.page.evaluate((url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((answer) => (answer.ok ? answer.text() : null)), url).catch(() => null);
      }, app.root),
      async cdp(method, params) {
        // One connection per tab, kept open: settings made over it (a slow
        // network, a throttled CPU) last only as long as it does.
        let connection = cdpSessions.get(ctx.page);
        const engine = browser.attached ? null : otherEngine(settings.browser);
        if (engine !== null) throw new StepFailure(`cdp is the Chrome DevTools Protocol, which ${engine} doesn't speak; use playwright, or a Chromium browser`);
        if (connection === undefined) {
          connection = await context.newCDPSession(ctx.page);
          cdpSessions.set(ctx.page, connection);
        }
        return connection.send(method as never, params as never);
      },
      mainProcess() {
        if (main === null) throw new UsageError("electron: this session has no main process to run code in. Open it with mainProcess, the port the app's --inspect gave it");
        return main;
      },
      async electron(code, arg) {
        // A function is called with the electron module and the argument, as Playwright's electronApp.evaluate does.
        const source = typeof code === "function" ? `await (${code.toString()})(electron, ${JSON.stringify(arg) ?? "undefined"})` : code;
        return (await ctx.mainProcess().evaluate(source, ctx.timeout)).value;
      },
      windowed: browser.windowed,
      get video() {
        return film.rolling;
      },
      film,
      mouse: { x: size.width / 2, y: size.height / 2 },
      artifacts: {
        dir,
        path(kind, file, extension) {
          mkdirSync(join(dir, kind), { recursive: true });
          return join(dir, kind, `${files}-${slug(file)}.${extension}`);
        },
        // A step's own, so the reply shows it with the step; one no step took is the job's.
        add(path) {
          const now = running.getStore();
          if (now !== undefined) (now.shots ??= []).push(path);
          else jobs.getStore()?.shots.push(path);
        },
        addFile: (path) => void jobs.getStore()?.files.push(path),
      },
      locate: (target, options) => locate(ctx, target, "locate", options),
      get params() {
        return jobs.getStore()?.params ?? {};
      },
      resolveFile: (file) => resolveFile(file, app),
      log: say,
      note(text) {
        recorder.note(`[weblab] note: ${text}`);
        const now = running.getStore();
        if (now !== undefined) (now.notes ??= []).push(text);
      },
      fail(message) {
        throw new StepFailure(message);
      },
      usage(message) {
        throw new UsageError(message);
      },
      // Code's own steps are for the session the code runs on, unless they say.
      step: (step) => codeStep(step, name),
      // Opened by a step, it goes to its first page as part of that step.
      async newSession(options = {}) {
        const made = await open(options, driver);
        const path = firstPath(made, options.path);
        if (path !== undefined) await codeStep({ goto: path }, made.name);
        return handle(made.name);
      },
      endSession: async (which) => {
        const ended = await end(which);
        report(ended);
      },
      refs: null,
    };

    const driver: Driver = {
      name,
      ctx,
      app,
      address: origin,
      ...(addressPath(options.address) === undefined ? {} : { firstPath: addressPath(options.address) }),
      server,
      attached: browser.attached,
      gone: () => browser.attached && context.browser()?.isConnected() === false,
      headed,
      dir,
      consoleLog,
      networkLog,
      consoleSinceLast: follow(consoleLog),
      shown: "",
      shownTabs: "",
      recorder,
      timeout,
      options,
      failed: false,
      async finish() {
        const kept: Ended = { name, dir };
        try {
          if (tracing) {
            // Kept when asked for outright, or when asked for on failure and a step failed.
            const keep = tracing === true || driver.failed;
            const path = join(dir, "traces", `${files}.zip`);
            await context.tracing.stop(keep ? { path } : {});
            if (keep) kept.trace = path;
          }
          // A take still being recorded ends with the session.
          if (film.rolling) kept.videos = await film.stop(ctx.page);
        } finally {
          await unwind();
        }
        if (left !== undefined) kept.server = left;
        return kept;
      },
    };
    // Two sessions on one tab of a running browser each drive it: said, since a step on one shows on the other.
    if (driver.attached) {
      const same = [...drivers.values()].filter((other) => other.attached && !other.gone() && other.app.settings.attach === settings.attach && other.ctx.page.url() === firstTab.url());
      if (same.length > 0) say(`note: ${same.map((other) => `"${other.name}"`).join(" and ")} ${same.length === 1 ? "is" : "are"} driving this same tab of ${settings.attach}; steps on any of them act on the one tab. Give tab or newTab to drive another.`);
    }
    drivers.set(name, driver);
    return driver;
  } catch (error) {
    await unwind();
    throw error;
  }
}

// Absolute, or relative to the file the step was written in, or the
// session's project, or where weblab was started.
async function resolveFile(file: string, app: App): Promise<string> {
  const now = running.getStore();
  const base = now === undefined ? undefined : bases.get(now);
  const dirs = [...(base === undefined ? [] : [base]), app.root, process.cwd()];
  const candidates = isAbsolute(file) ? [file] : dirs.map((dir) => resolve(dir, file));
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new StepFailure(`file not found: ${file} (looked beside the step's file and in ${app.root})`);
  return found;
}

// A session as code holds it: the same steps, said to be for it.
const handle = (name: string): SessionHandle => ({
  name,
  get page() {
    return pick(name).ctx.page;
  },
  get context() {
    return pick(name).ctx.context;
  },
  get origin() {
    return pick(name).ctx.origin;
  },
  get logs() {
    return pick(name).ctx.logs;
  },
  get responses() {
    return pick(name).ctx.responses;
  },
  locate: (target, options) => pick(name).ctx.locate(target, options),
  cdp: (method, params) => pick(name).ctx.cdp(method, params),
  electron: (code, arg) => pick(name).ctx.electron(code, arg),
  step: (step) => codeStep(step, name),
  end: async () => report(await end(name)),
});

// What a session left, said in the job that ended it.
function report(ended: Ended): void {
  const job = jobs.getStore();
  if (job === undefined) return;
  job.lines.push(...endedLines(ended));
}

/** What a session left when it ended, a line for each thing. */
export const endedLines = (ended: Ended): string[] => [
  `ended ${ended.name}`,
  ...(ended.videos ?? []).map((path) => `video ${path}`),
  ...(ended.trace === undefined ? [] : [`trace ${ended.trace}`]),
  ...(ended.server === undefined ? [] : [ended.server]),
];

/** Ends a session: its video and trace are finished, its browser closed, and its server let go of. */
export async function end(name: string): Promise<Ended> {
  const driver = pick(name);
  drivers.delete(name);
  return driver.finish();
}

/** Ends everything for good: no more sessions open, those on their way are waited for, and all are ended. */
export async function shutdown(): Promise<void> {
  leaving = true;
  while (arriving.size > 0) await Promise.allSettled([...arriving]);
  await endAll();
}

/** Ends every session, newest first. */
export async function endAll(): Promise<Ended[]> {
  const ended: Ended[] = [];
  for (const driver of [...drivers.values()].reverse()) {
    drivers.delete(driver.name);
    ended.push(await driver.finish().catch(() => ({ name: driver.name, dir: driver.dir })));
  }
  return ended;
}

// Every step comes through here, wherever it was written.
function invoke(step: Step, defaultOn: string): Promise<unknown> {
  const action = actionOf(step);
  const run = action === undefined ? undefined : builtinActions[action];
  if (action === "include") throw new UsageError("include works in steps given as JSON; in code, call step() for each step");
  if (action === undefined || run === undefined) {
    const guess = action === undefined ? undefined : nearest(action, Object.keys(builtinActions));
    throw new UsageError(`unknown step ${JSON.stringify(step)}${guess === undefined ? "" : ` (did you mean "${guess}"?)`}; every step is listed in the run tool's description`);
  }
  const args = step[action];
  if (run.noArgs && args !== true && args !== undefined) throw new UsageError(`${action}: takes no argument`);
  checkOptions(action, args);
  checkTimeout(step.timeout, action);
  if (step.on !== undefined && typeof step.on !== "string") throw new UsageError(`${action}: "on" is a session's name`);
  const on = (step.on as string | undefined) ?? defaultOn;
  // Opening a session isn't done on one: with none to take after, it is opened as the new tool would.
  if (action === "new" && !drivers.has(on)) {
    if (typeof args !== "string" && (args === null || typeof args !== "object" || Array.isArray(args)) && args !== true) throw new UsageError(`new: expected a name, or { ${SESSION_KEYS.join(", ")} }`);
    const options = typeof args === "string" ? { name: args } : args === true ? {} : (args as SessionOptions);
    return open(options).then(async (made) => {
      const path = firstPath(made, options.path);
      if (path !== undefined) await codeStep({ goto: path }, made.name);
    });
  }
  const driver = pick(on);
  // A running app that quit or restarted is gone, and the session can only be ended.
  if (action !== "end" && action !== "new" && driver.gone()) throw new StepFailure(GONE);
  const job = jobs.getStore();
  // Steps that code runs side by side on one session share its timeout: the last one set wins.
  driver.ctx.timeout = (step.timeout as number | undefined) ?? job?.timeout ?? driver.timeout;
  driver.ctx.context.setDefaultTimeout(driver.ctx.timeout);
  const now = running.getStore();
  if (now !== undefined) {
    ran.set(now, { driver, timeout: driver.ctx.timeout });
    if (action !== "new" && on !== job?.on) now.on = on;
  }
  return run(driver.ctx, args);
}

// Runs a step and fills in its record. A failure is thrown on, tagged
// with the step it came from, unless it came from a step inside this
// one, whose tag it keeps.
async function runRecorded(step: Step, entry: StepResult, base: string | undefined, defaultOn: string): Promise<unknown> {
  const begun = Date.now();
  bases.set(entry, base);
  try {
    const value = await running.run(entry, () => invoke(step, defaultOn));
    if (value !== undefined && entry.action !== "new") entry.value = value;
    return value;
  } catch (error) {
    const inner = failedIn.get(error as object);
    if (inner !== undefined) {
      Object.assign(entry, { status: "failed", error: inner.error });
      throw error;
    }
    const message = error instanceof UsageError ? error.message : failureText(step, error);
    Object.assign(entry, { status: "failed", error: message });
    const thrown = error instanceof UsageError ? error : new StepFailure(message);
    failedIn.set(thrown, entry);
    throw thrown;
  } finally {
    entry.ms = Date.now() - begun;
    if (entry.steps?.length === 0) delete entry.steps;
    // Its session goes back to the time of the step whose code ran this
    // one, if that was on the same session, else to the session's own.
    const mine = ran.get(entry);
    if (mine !== undefined && drivers.get(mine.driver.name) === mine.driver) {
      const parent = running.getStore();
      const theirs = parent === undefined ? undefined : ran.get(parent);
      mine.driver.ctx.timeout = theirs?.driver === mine.driver ? theirs.timeout : mine.driver.timeout;
      mine.driver.ctx.context.setDefaultTimeout(mine.driver.ctx.timeout);
    }
  }
}

const driverOf = (step: Step, defaultOn: string) => drivers.get(typeof step.on === "string" ? step.on : defaultOn);

// Code's own steps, recorded under the step running the code.
function codeStep(step: Step, defaultOn: string): Promise<unknown> {
  driverOf(step, defaultOn)?.recorder.note(`--- from code: ${JSON.stringify(step)}`);
  const parent = running.getStore();
  const siblings = parent === undefined ? (jobs.getStore()?.steps ?? []) : (parent.steps ??= []);
  const entry: StepResult = { index: siblings.length + 1, action: actionOf(step) ?? "?", step, status: "passed", ms: 0 };
  siblings.push(entry);
  return runRecorded(step, entry, parent === undefined ? undefined : bases.get(parent), defaultOn);
}

/**
 * One step of a job, on the session the job is for unless the step
 * says. A failure is recorded, with a picture of the page as it was,
 * and reported as `ok: false`; the session stays open.
 */
export async function runStep(job: Job, given: Step): Promise<{ ok: boolean; record: StepResult }> {
  const index = job.steps.length + 1;
  const action = actionOf(given) ?? "?";
  driverOf(given, job.on)?.recorder.note(`--- step ${index}: ${JSON.stringify(given)}`);
  const from = stepOrigin(given);
  const entry: StepResult = { index, action, step: given, ...(from === undefined ? {} : { from }), status: "passed", ms: 0 };
  job.steps.push(entry);
  try {
    await runRecorded(given, entry, stepBase(given), job.on);
    return { ok: true, record: entry };
  } catch (error) {
    const failed = failedIn.get(error as object);
    const inner = failed === undefined || failed === entry ? undefined : failed;
    // The session the step that failed was on, which may not be this step's own.
    const where = ran.get(failed ?? entry)?.driver ?? driverOf(given, job.on);
    // Said only when the step itself doesn't already say: code that drove another session.
    const on = where === undefined || where.name === (entry.on ?? job.on) ? "" : `on ${where.name}: `;
    const within = inner === undefined ? "" : `its step ${inner.index} (${inner.action}): `;
    // A step the app went away under says that, rather than what Playwright made of it.
    const message = where?.gone() ? `${on}${GONE}` : `${on}${within}${entry.error ?? stepError(error)}`;
    entry.error = message;
    // A step written wrong says nothing about the page: no picture, and the session's record is clean.
    if (error instanceof UsageError) {
      entry.refused = true;
      return { ok: false, record: entry };
    }
    if (where !== undefined && drivers.get(where.name) === where) {
      where.failed = true;
      // One line, so it never shows among the page's own console output.
      where.recorder.note(`[weblab] step ${index} (${action}) failed: ${message.replace(/\n\s*/g, " | ")}`);
      const which = inner === undefined ? `${index}-${slug(action)}` : `${index}.${inner.index}-${slug(inner.action)}`;
      const screenshot = where.ctx.artifacts.path("shots", `FAIL-${which}`, "png");
      // The page may be gone; the failure stands without its picture.
      const { page } = where.ctx;
      const shot = await withoutCursor(page, where.ctx.video, () => page.screenshot({ path: screenshot, timeout: 5000 })).then(() => screenshot, () => undefined);
      if (shot !== undefined) entry.screenshot = shot;
    }
    return { ok: false, record: entry };
  }
}

// Where in a code file an error came from, as " (checkout.ts:12)", if it did.
function codeLine(given: Step, error: unknown): string {
  const file = (given.playwright as { file?: unknown } | undefined)?.file;
  if (typeof file !== "string" || error instanceof StepFailure) return "";
  const name = file.split("/").pop() as string;
  const line = new RegExp(`${escapeRegExp(name)}:(\\d+)`).exec((error as Error)?.stack ?? "");
  return line === null ? "" : ` (${name}:${line[1]})`;
}

// Why a step failed: its own `message` leads, and what actually
// happened follows. An error thrown by a code file says where in it.
function failureText(given: Step, error: unknown): string {
  // Why a session couldn't open is written to be read whole: a server's last lines come with it.
  const detail = error instanceof SetupError ? error.message : `${stepError(error)}${codeLine(given, error)}`;
  const say = given.message as string | undefined;
  return say === undefined || say === detail ? detail : `${say} (${detail})`;
}

/** Every note a step and the steps inside it left, in order. */
export const notesOf = (step: StepResult): string[] => [...(step.notes ?? []), ...(step.steps ?? []).flatMap(notesOf)];

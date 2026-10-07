import type { BrowserContext, Locator, Page } from "playwright-core";
import type { MainProcess } from "./electron.ts";
import type { Film } from "./film.ts";
import type { SourceMapper } from "./sources.ts";

export type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};

/** What `goto` waits for before the next step runs. */
export type Ready = {
  selector?: string;
  text?: string;
  js?: string;
  timeout?: number;
};

/** One action key (`{ "click": "button" }`), plus optional `on`, `timeout`, `message` and `note`. */
export type Step = Record<string, unknown>;

/**
 * Playwright's own context options, passed through as given: colorScheme,
 * locale, timezoneId, permissions, geolocation, isMobile, hasTouch,
 * userAgent, storageState, reducedMotion, and the rest.
 */
export type ContextSettings = Record<string, unknown>;

/** How a session is driven: what `new` was told, or took from the session a `new` step ran on. */
export type Settings = {
  ready?: Ready;
  viewport?: Partial<Viewport>;
  context?: ContextSettings;
  /** Extra flags for the browser it launches. */
  browserArgs?: string[];
  /** `true` keeps a Playwright trace of the session; "on-failure" keeps it only if a step failed. */
  trace?: boolean | "on-failure";
  /** A saved sign-in (see the `saveState` step) to start from. */
  state?: string;
  timeout?: number;
  /** Console output and failed requests matching any of these patterns are left out of the log and the counts. */
  ignore?: string[];
  /** The browser to launch: a name (chrome, edge, brave, webkit, firefox, ...), an app's name, or a path. */
  browser?: string;
  /** A running browser to join instead of launching one: a debugging port or address. */
  attach?: string;
  /** Which of an attached browser's tabs to drive: part of its URL or title. */
  tab?: string;
  /** Drive a new tab in the attached browser, and leave its own alone. */
  newTab?: boolean;
  /** An attached Electron app's main process, for `electron` steps: the port or address its `--inspect` gave it. */
  mainProcess?: string;
  /** Keep one browser profile for this project between sessions. */
  persist?: boolean;
  /** Scripts run in every page before its own, as given (files, read relative to the project). */
  init?: string[];
};

/** The project a session was opened from: where defaults come from, and where its server starts. */
export type App = {
  /** The directory the session was given (or defaulted to): where `start` runs. */
  dir: string;
  /** Where its package.json sits, else the git toplevel, else the directory given. */
  root: string;
  /** The top of the git checkout it is in, if it is in one. */
  toplevel: string | null;
  /** `<repo>`, plus the worktree and the subdirectory when they differ: names artifact dirs. */
  label: string;
  /** A stable key from the root, naming this project's saved sign-ins and kept profiles. */
  key: string;
  /** How the session is driven. */
  settings: Settings;
};

/** The refs one tree printed, and the page (its address, and which load of it) they were of. */
export type Refs = { page: Page; url: string; load: number; names: Set<string> };

/** A console message or page error, as the console log records it. `process` is "main" for what an Electron app's main process logged. */
export type ConsoleEntry = { type: string; text: string; url?: string; process?: "main" };

/** A response the page had, as the network log records it. */
export type ResponseEntry = { status: number; method: string; url: string; mocked: boolean };

export type ActionContext = {
  /** The session's name. */
  name: string;
  /** The tab steps act on. The `tab` step changes it. */
  page: Page;
  context: BrowserContext;
  app: App;
  origin: string;
  /** What happens to alert, confirm and prompt dialogs. The `dialog` step changes it. */
  readonly dialogs: { accept: boolean; text?: string };
  /** How long the current step may take: its own `timeout`, else the run's, else the session's, else 10 s. */
  timeout: number;
  /** True when the browser has a window on the screen (headed, or attached), which a capture of the screen needs. */
  windowed: boolean;
  /** True while the session is being recorded (the video step), so pointer actions glide. */
  readonly video: boolean;
  /** Recording the tab steps act on: what the video step starts and stops. */
  film: Film;
  /** Where the drawn cursor last was. */
  mouse: { x: number; y: number };
  artifacts: {
    dir: string;
    /** Where a file of this session's lands in its artifacts directory: `shots/<session>-<name>.png`. The caller writes it. */
    path(dir: string, name: string, extension: string): string;
    /** Registers a screenshot so the reply shows it. */
    add(path: string): void;
    /** Registers any other file the step wrote, such as a saved `look`. */
    addFile(path: string): void;
  };
  /**
   * The refs the latest tree printed: null when none are current. A ref
   * outside them, or one from a page the steps have since left, is
   * reported at once instead of waited for.
   */
  refs: Refs | null;
  /** Requests a `mock` answered, so the network log can say so. */
  mocked: WeakSet<object>;
  /** What every tab has logged so far, past what's ignored: console messages and page errors. */
  logs: ConsoleEntry[];
  /** Every response every tab has had so far. */
  responses: ResponseEntry[];
  /** How many documents the current tab has loaded: a reload makes a new one. */
  loads(): number;
  /** What the current tab has logged and received since it last loaded a page. */
  sinceLoad(): { logs: ConsoleEntry[]; responses: ResponseEntry[] };
  /** Leaves more console output and failed requests out, from now on. */
  ignore(patterns: string[]): void;
  /** Places in the page's code (or the main process's), put back as places in the project's source through source maps. */
  sources: SourceMapper;
  /** Sends a raw Chrome DevTools Protocol command to the current tab, over a connection kept open for it. */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Runs code in the attached Electron app's main process and hands back its value: statements
   * whose last one's value it is, or a function given `electron` and `arg`. Needs `mainProcess`.
   */
  electron(code: string | ((electron: any, arg: any) => unknown), arg?: unknown): Promise<unknown>;
  /** The attached Electron app's main process, as `electron` and `expect` use it. A usage error if the session has none. */
  mainProcess(): MainProcess;
  /** Turns a target (a selector, a ref, `{ role, name }`, ...) into a Playwright locator, as the built-in steps do. */
  locate(target: unknown, options?: { all?: boolean }): Locator;
  /** The `params` the run was given, for code to read. */
  readonly params: Record<string, unknown>;
  /** Finds a file a step names: absolute, or relative to the file the step was written in, or the project. */
  resolveFile(file: string): Promise<string>;
  log(line: string): void;
  /** Something the reader should know about the step that's running, though it passed: shown with its result. */
  note(text: string): void;
  /** Runs one weblab step from code and hands back what it returns: `await ctx.step({ js: "document.title" })`. Throws if it fails. */
  step(step: Step): Promise<unknown>;
  /** Opens another session, as the `new` step does, and hands back a way to drive it from code. */
  newSession(options?: SessionOptions): Promise<SessionHandle>;
  /** Ends a session by name, as the `end` step does. */
  endSession(name: string): Promise<void>;
  /** The step ran and came out wrong. */
  fail(message: string): never;
  /** The step was written wrong. */
  usage(message: string): never;
};

/**
 * What `new` takes, as a tool and as a step: how one session is driven.
 * With nothing but a name, a browser of its own at the project's dev
 * server. As a step, what isn't said is as the session the step ran on.
 */
export type SessionOptions = {
  /** What steps say with `on`, and what its files are named after (default: main, then session2, session3, ...). */
  name?: string;
  /** The project: where `start` runs, and where relative paths are read from. */
  dir?: string;
  /** Where the app answers: a URL, host:port, or a port. */
  address?: string | number;
  /** The command that starts what answers at the address, when nothing does yet. */
  start?: string;
  /** How long a server weblab starts gets to answer, in milliseconds. */
  startTimeout?: number;
  /** Where to go first: a path or URL (default: "/", or where an attached browser already is). */
  path?: string;
  attach?: string | number;
  tab?: string;
  newTab?: boolean;
  mainProcess?: string | number;
  browser?: string;
  browserArgs?: string[];
  headed?: boolean;
  persist?: boolean;
  /** A saved sign-in to start from. Never taken from another session: a second session is a second user. */
  state?: string;
  viewport?: string | Partial<Viewport>;
  context?: ContextSettings;
  trace?: boolean | "on-failure";
  timeout?: number;
  ignore?: string[];
  ready?: Ready;
  /** A script file, or several, run in every page before the page's own scripts: a stub for what a page expects to find (an Electron preload's API). */
  init?: string | string[];
  /** Where its screenshots, logs and videos go. */
  out?: string;
};

/** A session as code holds it, driven with the same steps. Ended with `end()`, or like any other. */
export type SessionHandle = Pick<ActionContext, "name" | "locate" | "cdp" | "electron" | "step"> & {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly origin: string;
  readonly logs: ConsoleEntry[];
  readonly responses: ResponseEntry[];
  end(): Promise<void>;
};

// What it resolves to is the step's value: what a code step returns, or the text a `look` read.
export type Action = ((ctx: ActionContext, args: any) => Promise<unknown>) & {
  /** The step takes no argument: `{ "back": true }`. */
  noArgs?: boolean;
  /** What the step hands back is text to read, printed as it is rather than as JSON: a look, a react step. */
  prints?: boolean;
};

export type StepResult = {
  index: number;
  action: string;
  /** The step as it was given. */
  step?: Step;
  status: "passed" | "failed";
  ms: number;
  error?: string;
  /** It never ran: it was written wrong, or named what isn't there. */
  refused?: boolean;
  /** What the step handed back: a code step's return value. */
  value?: unknown;
  /** The session it ran on, when not the one the run was for. */
  on?: string;
  /** Where a step brought in by an include came from: `pose.json step 2`. */
  from?: string;
  /** The steps a code step ran with `step()`, in order. */
  steps?: StepResult[];
  /** What the step wanted the reader to know, though it passed. */
  notes?: string[];
  /** The screenshots the step took. */
  shots?: string[];
  /** The page as it was when the step failed. */
  screenshot?: string;
};

// Watching the browser context while a session is open: what every tab
// logs, which responses come back, when a tab loads a new document, and
// which WebSockets open. All of it goes to the session's console and
// network logs, and is kept for checks and code to ask about.
import { appendFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, ConsoleMessage, Dialog, Page, Request, Response, WebError, WebSocket } from "playwright-core";
import { cut, stripAnsi, UsageError } from "./errors.ts";
import type { ConsoleEntry, ResponseEntry } from "./types.ts";

/** Counts of console errors, page errors and failed requests. */
export type ErrorCounts = { console: number; page: number; request: number };

// A console line longer than this is cut in the log: a logged data URL
// or an inlined image says nothing a reader needs.
const MAX_CONSOLE_LINE = 1000;
// What every dev server says on every page load, and nobody needs to read.
const ALWAYS_IGNORED = [/^\[console\.debug\] \[vite\] connect(ing|ed)/];

// A console message as the browser would show it: `%s` and its kin
// filled in from the arguments, `%c` styling dropped, colour codes gone.
function consoleText(message: ConsoleMessage): string {
  const [format, ...rest] = message.args().map((handle) => handle.toString());
  if (format === undefined || !format.includes("%")) return stripAnsi(message.text());
  const filled = format.replace(/%([sdifoOc%])/g, (whole, kind: string) => {
    if (kind === "%") return "%";
    const value = rest.shift();
    if (value === undefined) return whole;
    return kind === "c" ? "" : value;
  });
  return stripAnsi([filled, ...rest].join(" "));
}

// The tab a request or response belongs to; a service worker's belongs to none.
function tabOf(owner: { frame(): { page(): Page } }): Page | null {
  try {
    return owner.frame().page();
  } catch {
    return null;
  }
}

export type Recorder = {
  /** What every tab has logged, past what's ignored. */
  logs: ConsoleEntry[];
  /** Every response every tab has had. */
  responses: ResponseEntry[];
  /** How many documents a tab has loaded. */
  loads(tab: Page): number;
  /** What a tab has logged and received since it last loaded a document. */
  sinceLoad(tab: Page): { logs: ConsoleEntry[]; responses: ResponseEntry[] };
  /** Ignores more console messages and failed requests, from now on. */
  ignore(patterns: string[]): void;
  /** A line in the console log, from weblab rather than the page. */
  note(line: string): void;
  /** What an Electron app's main process logged: for every tab, as a worker's is. */
  fromMain(type: string, text: string): void;
  /** Takes the listeners off again: an attached browser's context outlives the session. */
  stop(): void;
};

export function record(
  context: BrowserContext,
  first: Page,
  options: {
    consoleLog: string;
    networkLog: string;
    ignore: string[];
    /** Requests a `mock` answered, so neither the logs nor `noErrors` blame the page for them. */
    mocked: WeakSet<object>;
    /** Counts of console errors, page errors and failed requests, kept on the result. */
    errors: ErrorCounts;
    onDialog(dialog: Dialog): void;
  },
): Recorder {
  const { consoleLog, networkLog, mocked, errors } = options;
  writeFileSync(consoleLog, "");
  writeFileSync(networkLog, "");
  const note = (line: string) => appendFileSync(consoleLog, `${line}\n`);
  const network = (line: string) => appendFileSync(networkLog, `${line}\n`);

  const ignored = [...ALWAYS_IGNORED];
  const ignore = (patterns: string[]) => {
    for (const pattern of patterns) {
      try {
        ignored.push(new RegExp(pattern));
      } catch (error) {
        throw new UsageError(`ignore: ${pattern}: ${(error as Error).message}`);
      }
    }
  };
  ignore(options.ignore);

  const logs: ConsoleEntry[] = [];
  const responses: ResponseEntry[] = [];
  // Which tab each entry came from, so a check can ask about the page it is on.
  const tabFor = new WeakMap<object, Page | null>();
  // Where each tab's current document starts in the two lists, and how
  // many it has loaded: set when the tab begins loading a new one.
  const loadedAt = new WeakMap<Page, { logs: number; responses: number; count: number }>();
  // URLs a mock answered with an error or aborted: the browser's own
  // "Failed to load resource" about them is what the mock was for.
  const mockedUrls = new Set<string>();

  const heard = (kind: keyof ErrorCounts | null, line: string, entry?: ConsoleEntry, tab?: Page | null) => {
    if (ignored.some((pattern) => pattern.test(line))) return;
    if (kind !== null) errors[kind] += 1;
    if (entry !== undefined) {
      logs.push(entry);
      tabFor.set(entry, tab ?? null);
    }
    note(cut(line, MAX_CONSOLE_LINE));
  };

  // WebSockets carry no responses, so the network log notes them itself.
  const onSocket = (socket: WebSocket) => {
    network(`WS ${socket.url()}`);
    socket.on("close", () => network(`WS closed ${socket.url()}`));
  };
  const tabs: Page[] = [];
  const watch = (tab: Page) => {
    tabs.push(tab);
    tab.on("websocket", onSocket);
  };

  // On the context, so a tab a click opens is covered from its first
  // request, before anything could be attached to the tab itself.
  const listeners = {
    console(message: ConsoleMessage) {
      // The source URL says which resource a bare "Failed to load" was about.
      const { url } = message.location();
      const text = consoleText(message);
      const fromMock = message.type() === "error" && text.startsWith("Failed to load resource") && mockedUrls.has(url);
      const line = `[console.${message.type()}] ${text}${url ? ` (${url})` : ""}${fromMock ? " (mocked)" : ""}`;
      const entry = { type: fromMock ? "info" : message.type(), text: cut(text, MAX_CONSOLE_LINE), ...(url ? { url } : {}) };
      heard(message.type() === "error" && !fromMock ? "console" : null, line, entry, message.page());
    },
    weberror(webError: WebError) {
      const error = webError.error();
      heard("page", `[pageerror] ${error.stack || error.message}`, { type: "pageerror", text: error.message }, webError.page());
    },
    request(request: Request) {
      // A tab starting on a new document starts a new page, as far as checks go.
      if (!request.isNavigationRequest()) return;
      const tab = tabOf(request);
      if (tab !== null && request.frame() === tab.mainFrame()) {
        loadedAt.set(tab, { logs: logs.length, responses: responses.length, count: (loadedAt.get(tab)?.count ?? 0) + 1 });
      }
    },
    requestfailed(request: Request) {
      const line = `[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`;
      if (!mocked.has(request)) return heard("request", line);
      // A mock that aborts the request means it to fail.
      mockedUrls.add(request.url());
      note(`${line} (mocked)`);
    },
    response(response: Response) {
      const fromMock = mocked.has(response.request());
      const entry = { status: response.status(), method: response.request().method(), url: response.url(), mocked: fromMock };
      responses.push(entry);
      tabFor.set(entry, tabOf(response));
      const line = `${response.status()} ${response.request().method()} ${response.url()}${fromMock ? " (mocked)" : ""}`;
      network(line);
      if (fromMock) mockedUrls.add(response.url());
      else if (response.status() >= 400) heard("request", `[http ${line}]`);
    },
    dialog: options.onDialog,
    page: watch,
  };
  // Playwright types each event on its own; here they're handled alike.
  type Listen = (event: string, listener: (...args: never[]) => void) => unknown;
  const events = Object.entries(listeners) as [string, (...args: never[]) => void][];
  for (const [event, listener] of events) (context.on as Listen).call(context, event, listener);
  watch(first);

  // An entry from no tab in particular (a worker) counts for every tab.
  const of = (tab: Page) => (entry: object) => [tab, null, undefined].includes(tabFor.get(entry));
  return {
    logs,
    responses,
    loads: (tab) => loadedAt.get(tab)?.count ?? 0,
    sinceLoad(tab) {
      const at = loadedAt.get(tab) ?? { logs: 0, responses: 0 };
      return { logs: logs.slice(at.logs).filter(of(tab)), responses: responses.slice(at.responses).filter(of(tab)) };
    },
    ignore,
    note,
    fromMain(type, text) {
      const entry = { type, text: cut(text, MAX_CONSOLE_LINE), process: "main" as const };
      heard(type === "error" ? "console" : null, `[main console.${type}] ${text}`, entry, null);
    },
    stop() {
      for (const [event, listener] of events) (context.off as Listen).call(context, event, listener);
      for (const tab of tabs) tab.off("websocket", onSocket);
    },
  };
}

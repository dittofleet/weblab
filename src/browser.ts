import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright-core";
import playwright from "playwright-core/package.json" with { type: "json" };
import { briefError, SetupError, UsageError } from "./errors.ts";
import { profileDir } from "./state.ts";
import { openedByWeblab } from "./tabs.ts";
import type { App, ContextSettings, Viewport } from "./types.ts";
import { onPath } from "./util.ts";

export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900, deviceScaleFactor: 2 };

type ContextOptions = {
  viewport: Viewport;
  /** True when the session asked for a size, rather than getting the default. */
  viewportGiven?: boolean;
  /** True when the session chose a pixel scale, rather than taking the default. */
  scaleGiven?: boolean;
  settings?: ContextSettings;
  videoDir?: string;
};

type Opened = {
  context: BrowserContext;
  /** The page to drive, when there already is one: an attached browser's window. */
  page?: Page;
  close(): Promise<void>;
};

export type BrowserManager = {
  /** A context for one session. `close` also finalizes its video. */
  open(options: ContextOptions): Promise<Opened>;
  close(): Promise<void>;
  /** True when weblab joined a browser that was already running, and so must leave it as it found it. */
  attached: boolean;
  /** True when the browser has a window on the screen: launched headed, or attached. */
  windowed: boolean;
};

// Names for the browsers Playwright knows how to find by itself.
const CHANNELS: Record<string, string> = {
  chrome: "chrome",
  "chrome-beta": "chrome-beta",
  "chrome-dev": "chrome-dev",
  "chrome-canary": "chrome-canary",
  edge: "msedge",
  "edge-beta": "msedge-beta",
  "edge-dev": "msedge-dev",
};

// What a few other Chromium browsers call their app and their binary.
const APPS: Record<string, { app: string; bin: string[] }> = {
  chromium: { app: "Chromium", bin: ["chromium", "chromium-browser"] },
  brave: { app: "Brave Browser", bin: ["brave-browser", "brave"] },
  helium: { app: "Helium", bin: ["helium"] },
  vivaldi: { app: "Vivaldi", bin: ["vivaldi"] },
  arc: { app: "Arc", bin: [] },
  opera: { app: "Opera", bin: ["opera"] },
};

// The other engines, for what only shows there: Safari's is WebKit.
// These are Playwright's own builds, downloaded once; weblab drives no
// installed Safari or Firefox.
const ENGINES: Record<string, { type: BrowserType; name: string }> = {
  webkit: { type: webkit, name: "webkit" },
  safari: { type: webkit, name: "webkit" },
  firefox: { type: firefox, name: "firefox" },
};

/** True when the browser asked for isn't a Chromium one, so what works over the DevTools protocol doesn't. */
export const otherEngine = (wanted: string | undefined): string | null => ENGINES[(wanted ?? "chrome").toLowerCase()]?.name ?? null;

// The binary inside a macOS app bundle is named after the app.
function insideApp(bundle: string): string | null {
  const dir = join(bundle, "Contents", "MacOS");
  if (!existsSync(dir)) return null;
  const [first] = readdirSync(dir);
  return first === undefined ? null : join(dir, first);
}

/**
 * Which browser to launch: any Chromium-based one. A name Playwright
 * knows, a name from the list above, the name of any installed app, or
 * the path to a binary or an .app bundle.
 */
function browserToLaunch(wanted = "chrome"): { channel: string } | { executablePath: string } {
  const channel = CHANNELS[wanted.toLowerCase()];
  if (channel !== undefined) return { channel };
  if (wanted.includes("/")) {
    const path = wanted.endsWith(".app") ? insideApp(wanted) : wanted;
    if (path === null || !existsSync(path)) throw new UsageError(`browser: nothing at ${wanted}`);
    return { executablePath: path };
  }
  const known = APPS[wanted.toLowerCase()];
  const app = known?.app ?? wanted;
  for (const applications of ["/Applications", join(homedir(), "Applications")]) {
    const path = insideApp(join(applications, `${app}.app`));
    if (path !== null) return { executablePath: path };
  }
  for (const bin of known?.bin ?? [wanted]) {
    const path = onPath(bin);
    if (path !== null) return { executablePath: path };
  }
  throw new UsageError(
    `browser: no browser called "${wanted}" found. Give a path, or one of: ${[...Object.keys(CHANNELS), ...Object.keys(APPS), ...Object.keys(ENGINES)].join(", ")}`,
  );
}

function launchError(error: unknown, wanted: string): SetupError {
  const message = briefError(error);
  const engine = otherEngine(wanted);
  if (!/is not found|executable doesn't exist/i.test(message)) return new SetupError(`could not launch ${wanted}: ${message}`);
  return new SetupError(
    engine !== null
      ? `${engine} needs Playwright's own build of it, a one-time download: bunx playwright-core@${playwright.version} install ${engine}`
      : `${wanted} is not installed (weblab drives a browser already on the machine and downloads none; the browser option picks another)`,
  );
}

// Pages that belong to the browser itself, not to anything being tested.
const INTERNAL = /^(devtools|chrome|chrome-extension|chrome-untrusted|edge):/;

/** `9222`, `localhost:9222`, or a full http:// or ws:// address. */
const endpoint = (attach: string) =>
  /^\d+$/.test(attach) ? `http://127.0.0.1:${attach}` : /^[a-z]+:\/\//.test(attach) ? attach : `http://${attach}`;

// A tab that comes from `mine`: one a step opened from it, or a popup
// of it, or one of those of one of those.
async function comesFrom(tab: Page, mine: Page): Promise<boolean> {
  for (let from: Page | null | undefined = tab; from != null; from = openedByWeblab.get(from) ?? (await from.opener())) {
    if (from === mine) return true;
  }
  return false;
}

/**
 * Joins a browser that is already running, over the debugging port it
 * was started with: an Electron app, or a Chrome with a profile that
 * is already signed in. It is someone else's browser, so nothing in it
 * is closed or resized that weblab did not open or was not asked to.
 */
function attachManager(app: App): BrowserManager {
  const { attach = "", tab: wanted, newTab } = app.settings;
  const address = endpoint(attach);
  // Joined once, however many sessions open at the same moment.
  let joining: Promise<Browser> | null = null;
  return {
    attached: true,
    windowed: true,
    async open(options) {
      joining ??= chromium.connectOverCDP(address).catch((error) => {
        joining = null;
        throw new SetupError(
          `could not attach to ${address}: ${briefError(error)} (the browser or app has to be started with a remote debugging port)`,
        );
      });
      const browser = await joining;
      const context = browser.contexts()[0];
      if (context === undefined) throw new SetupError(`${address} has no browser context to drive`);
      const before = new Set(context.pages());

      let page: Page | undefined;
      if (newTab) {
        page = await context.newPage().catch((error) => {
          throw new SetupError(`could not open a new tab in the attached browser: ${briefError(error)}`);
        });
      } else {
        const pages = context.pages().filter((candidate) => !INTERNAL.test(candidate.url()));
        if (wanted === undefined) {
          page = pages[0];
        } else {
          for (const candidate of pages) {
            if (candidate.url().includes(wanted) || (await candidate.title().catch(() => "")).includes(wanted)) {
              page = candidate;
              break;
            }
          }
        }
        if (page === undefined) {
          const open = pages.map((candidate) => `\n  ${candidate.url()}`).join("") || " none";
          throw new SetupError(
            wanted === undefined
              ? `the attached browser has no tab to drive; open the session with newTab to open one`
              : `no tab in the attached browser matches "${wanted}". Open tabs:${open}`,
          );
        }
      }
      if (options.viewportGiven) {
        await page.setViewportSize({ width: options.viewport.width, height: options.viewport.height });
      }
      return {
        context,
        page,
        // Only what this session opened: its new tab, tabs its steps
        // opened, and popups from those. A tab the user opened meanwhile stays.
        async close() {
          // Decided before any closes: a closed tab no longer says what it opened.
          const closing: Page[] = [];
          for (const tab of context.pages()) {
            if (tab === page ? !before.has(tab) : !before.has(tab) && (await comesFrom(tab, page))) closing.push(tab);
          }
          for (const tab of closing) await tab.close().catch(() => {});
        },
      };
    },
    // For a browser joined over CDP this lets go of it; the browser stays up.
    async close() {
      const joined = joining;
      joining = null;
      await (await joined?.catch(() => null))?.close().catch(() => {});
    },
  };
}

export function createBrowserManager(app: App, options: { headed: boolean }): BrowserManager {
  if (app.settings.attach !== undefined) return attachManager(app);

  const wanted = app.settings.browser ?? "chrome";
  const engine = ENGINES[wanted.toLowerCase()];
  const type = engine?.type ?? chromium;
  const launch = {
    ...(engine === undefined ? browserToLaunch(wanted) : {}),
    headless: !options.headed,
    args: app.settings.browserArgs ?? [],
    // Left to itself, Playwright ends the whole process on a signal, as
    // soon as its browsers are closed. weblab has more to put away than
    // that (the server it started), and closes the browser as part of it.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
  const contextOptions = ({ viewport, scaleGiven, settings, videoDir }: ContextOptions) => ({
    ...settings,
    viewport: { width: viewport.width, height: viewport.height },
    // A window on a real display keeps that display's own scale unless
    // one is asked for: what the OS draws over the page (a menu, a
    // tooltip) is drawn at the display's scale, and wouldn't line up.
    ...(options.headed && !scaleGiven ? {} : { deviceScaleFactor: viewport.deviceScaleFactor }),
    ...(videoDir === undefined
      ? {}
      : { recordVideo: { dir: videoDir, size: { width: viewport.width, height: viewport.height } } }),
  });

  // The opt-in profile keeps what an app caches in the browser (a
  // model in IndexedDB) between sessions. It is per project and per
  // browser, and its lock means one session uses it at a time.
  if (app.settings.persist) {
    const profile = profileDir(app, wanted);
    return {
      attached: false,
      windowed: options.headed,
      async open(opts) {
        // A profile already carries its own cookies and storage.
        if (opts.settings?.storageState !== undefined) {
          throw new SetupError("a saved state can't be combined with persist; use one or the other");
        }
        const context = await type
          .launchPersistentContext(profile, { ...launch, ...contextOptions(opts) })
          .catch((error) => {
            throw launchError(error, wanted);
          });
        return { context, close: () => context.close() };
      },
      close: async () => {},
    };
  }

  // Launched once, however many sessions open at the same moment.
  let launching: Promise<Browser> | null = null;
  return {
    attached: false,
    windowed: options.headed,
    async open(opts) {
      launching ??= type.launch(launch).catch((error) => {
        launching = null;
        throw launchError(error, wanted);
      });
      const context = await (await launching).newContext(contextOptions(opts));
      return { context, close: () => context.close() };
    },
    async close() {
      const launched = launching;
      launching = null;
      // Whatever state the browser is in (still launching, already gone), closing never throws.
      await (await launched?.catch(() => null))?.close().catch(() => {});
    },
  };
}

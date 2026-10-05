// Capturing the real screen: what a person looking at the browser's
// window sees, with everything the operating system draws over the page
// and Chrome's own screenshots leave out: an open <select>, a context
// menu, a date picker, autofill.
//
// The capture is of the browser's own window and the menus it has open,
// asked for by window rather than by place on the screen, so whatever
// else is on the screen (another agent's browser, overlapping this one)
// stays out of it. It needs a window, so it only works with a headed or
// attached browser.
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { browserProcess } from "./browser.ts";
import { briefError } from "./errors.ts";
import type { ActionContext } from "./types.ts";
import { tryExec } from "./util.ts";
import type { Locator, Page } from "playwright-core";

export const SCREEN_AREAS = ["page", "window", "display"] as const;
/** How much of the screen: the page's part of the window, the whole window, or the display it is on. */
export type ScreenArea = (typeof SCREEN_AREAS)[number];

export type Rect = { x: number; y: number; width: number; height: number };

// How long nobody has touched the keyboard or pointer, in seconds; 0 when it can't be told.
function idleSeconds(): number {
  const idle = /"HIDIdleTime" = (\d+)/.exec(tryExec("ioreg", ["-c", "IOHIDSystem", "-d", "4"]) ?? "")?.[1];
  return idle === undefined ? 0 : Number(idle) / 1e9;
}

// A display that is asleep shows no menus and gives no captures, and
// nothing says whether it is. So a session with a window wakes it once, at
// the start, and holds it awake for as long as this process lives; one
// left alone for a while is given a moment to come on.
let heldAwake = false;
export async function keepDisplayAwake(): Promise<void> {
  if (heldAwake) return;
  heldAwake = true;
  const idle = idleSeconds();
  // -u: as if the user had touched something, which wakes it. -d -w: no display sleep until this process ends.
  // Where there is no caffeinate, the display is left to itself.
  for (const args of [["-u", "-t", "5"], ["-d", "-w", String(process.pid)]]) {
    spawn("caffeinate", args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  // Waking fades the picture in, and a capture taken mid-fade is washed out.
  if (idle > 30) await sleep(2500);
}

// Whether macOS lets this process (in truth, the app it runs under: the
// terminal) record the screen. Without that a capture shows the
// wallpaper and nothing else, with no error. Null when it can't be told.
async function mayRecordScreen(): Promise<boolean | null> {
  try {
    const { dlopen } = await import("bun:ffi");
    const graphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGPreflightScreenCaptureAccess: { args: [], returns: "bool" },
    });
    return graphics.symbols.CGPreflightScreenCaptureAccess();
  } catch {
    return null;
  }
}

/**
 * Run in every page of a browser with a window: notes, from each pointer
 * event, where the page's top left is on the screen. Nothing else says:
 * the sizes a page reports are the emulated viewport's, not the window's.
 */
export const TRACK_PAGE_ON_SCREEN = `(() => {
  if (window !== window.top) return;
  const note = (event) => { window.__weblabPageOnScreen = { x: event.screenX - event.clientX, y: event.screenY - event.clientY }; };
  addEventListener("mousemove", note, { capture: true, passive: true });
  addEventListener("mousedown", note, { capture: true, passive: true });
})()`;

type Point = { x: number; y: number };
// Where each tab's page starts within its window, which stays put
// while the page inside loads and changes.
const pageInWindow = new WeakMap<Page, Point>();

async function pageOrigin(ctx: ActionContext, window: Rect): Promise<Point> {
  const read = () => ctx.page.evaluate(() => (globalThis as { __weblabPageOnScreen?: Point }).__weblabPageOnScreen ?? null);
  let seen = await read();
  if (seen === null && !pageInWindow.has(ctx.page)) {
    // No pointer step has run yet, so nothing is hovered that a move could disturb.
    await ctx.page.evaluate(TRACK_PAGE_ON_SCREEN);
    await ctx.page.mouse.move(1, 1);
    seen = await read();
  }
  if (seen !== null) pageInWindow.set(ctx.page, { x: seen.x - window.x, y: seen.y - window.y });
  const within = pageInWindow.get(ctx.page);
  if (within === undefined) return ctx.fail(`where the page sits in its window couldn't be told; capture { "screen": "window" } instead`);
  return { x: window.x + within.x, y: window.y + within.y };
}

// Runs a command for its output, or fails the step saying what couldn't be done.
function run(ctx: ActionContext, what: string, command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  } catch (error) {
    return ctx.fail(`${what} (${briefError(error)})`);
  }
}

// A JavaScript for Automation script, which reaches the macOS frameworks.
const jxa = (ctx: ActionContext, what: string, script: string, ...args: string[]) => run(ctx, what, "osascript", ["-l", "JavaScript", "-e", script, ...args]);

// Every display's frame, as AppKit counts: up from the main display's bottom left.
const LIST_DISPLAYS = `ObjC.import("AppKit");
JSON.stringify($.NSScreen.screens.js.map((s) => [s.frame.origin.x, s.frame.origin.y, s.frame.size.width, s.frame.size.height]))`;

// The display the window is on (the one holding its middle). The page
// can't say: the screen it reports is the emulated one.
function displayOf(ctx: ActionContext, window: Rect): Rect {
  const frames: [number, number, number, number][] = JSON.parse(jxa(ctx, `the displays couldn't be listed; capture { "screen": "window" } instead`, LIST_DISPLAYS));
  // AppKit counts up from the main display's bottom left; captures count down from its top left.
  const mainHeight = frames[0]?.[3] ?? 0;
  const displays = frames.map(([x, y, width, height]) => ({ x, y: mainHeight - y - height, width, height }));
  const middle = { x: window.x + window.width / 2, y: window.y + window.height / 2 };
  const holds = (d: Rect) => middle.x >= d.x && middle.x < d.x + d.width && middle.y >= d.y && middle.y < d.y + d.height;
  return displays.find(holds) ?? displays[0] ?? ctx.fail("no display was found");
}

type OnScreen = { id: number; pid: number; layer: number; bounds: Rect };

// Every window on screen, front to back, as the window server lists them.
const LIST_WINDOWS = `ObjC.import("CoreGraphics");
JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))).map((w) => ({
  id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, layer: w.kCGWindowLayer,
  bounds: { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height },
})))`;

const windowsOnScreen = (ctx: ActionContext): OnScreen[] => JSON.parse(jxa(ctx, "the windows on screen couldn't be listed", LIST_WINDOWS));

// Cuts a picture down to one rectangle of it, in pixels from its top left.
const CROP = `ObjC.import("AppKit");
function run([file, x, y, width, height]) {
  const source = $.NSBitmapImageRep.imageRepWithData($.NSData.dataWithContentsOfFile(file));
  const cut = $.CGImageCreateWithImageInRect(source.CGImage, $.CGRectMake(Number(x), Number(y), Number(width), Number(height)));
  const png = $.NSBitmapImageRep.alloc.initWithCGImage(cut).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (!png.writeToFileAtomically(file, true)) throw new Error("could not write " + file);
}`;

// The part of a rectangle inside another.
function clip(rect: Rect, within: Rect): Rect {
  const x = Math.max(rect.x, within.x);
  const y = Math.max(rect.y, within.y);
  return {
    x,
    y,
    width: Math.min(rect.x + rect.width, within.x + within.width) - x,
    height: Math.min(rect.y + rect.height, within.y + within.height) - y,
  };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
// Within a point either way: window positions come rounded differently from each side.
const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const sameRect = (a: Rect, b: Rect) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

// A picture's size in pixels.
function pixels(ctx: ActionContext, file: string): { width: number; height: number } {
  const info = run(ctx, "the capture's size couldn't be read", "sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const read = (key: string) => Number(new RegExp(`${key}: (\\d+)`).exec(info)?.[1]);
  return { width: read("pixelWidth"), height: read("pixelHeight") };
}

/** Where the tab's window is on the screen, in the points Chrome and the window server both count in. */
async function windowBounds(ctx: ActionContext): Promise<Rect> {
  const { bounds } = (await ctx.cdp("Browser.getWindowForTarget")) as { bounds: { left: number; top: number; width: number; height: number } };
  return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
}

// The browser's window, with the menus it has open over it, and nothing
// else: asked for by window, it comes whole even from under another.
async function captureWindow(ctx: ActionContext, path: string, bounds: Rect, part: Rect | null): Promise<void> {
  const pid = await browserProcess(ctx.context);
  const onScreen = windowsOnScreen(ctx);
  const window = onScreen.find((w) => w.layer === 0 && (pid === null || w.pid === pid) && sameRect(w.bounds, bounds));
  if (window === undefined) {
    return ctx.fail("the browser's window isn't on the screen (minimised, or on another desktop?), so there is nothing of it to capture");
  }
  // A menu is a window of its own. Asked for the frontmost one, the
  // window server hands back the browser's window with its menus on it.
  const menus = onScreen.filter((w) => w.pid === window.pid && w.layer !== 0 && overlaps(w.bounds, window.bounds));
  // -x: no shutter sound. -o: no window shadow. -l: one window, by its number.
  run(ctx, "the window couldn't be captured", "screencapture", ["-x", "-o", "-l", String((menus[0] ?? window).id), path]);
  if (part === null) return;
  // The picture is of the window, at the display's pixel scale: cut the part wanted out of it.
  const size = pixels(ctx, path);
  const scale = size.width / window.bounds.width;
  if (!near(size.height / scale, window.bounds.height)) {
    return void ctx.note("the capture reaches past the browser's window (a menu does), so it was kept whole rather than cut to the page");
  }
  const cut = [part.x - window.bounds.x, part.y - window.bounds.y, part.width, part.height].map((points) => String(Math.round(points * scale)));
  jxa(ctx, `the capture couldn't be cut to size; the whole window is at ${path}`, CROP, path, ...cut);
}

/**
 * Captures the browser as it shows on the real screen to a file: the
 * page, one element, the whole window, or the display it is on.
 */
export async function captureScreen(ctx: ActionContext, path: string, area: ScreenArea, target?: Locator): Promise<void> {
  if (!ctx.windowed) {
    ctx.usage(`shot: "screen" captures the real screen, so the browser needs a window: open the session with headed, or attach to an app that has one`);
  }
  if ((await mayRecordScreen()) === false) {
    ctx.fail(
      "macOS hasn't allowed screen recording for the app weblab runs under (the terminal, or the agent's app): " +
        "allow it in System Settings > Privacy & Security > Screen & System Audio Recording, then start that app again",
    );
  }

  // The window isn't brought forward here: that would close the very
  // menu the capture is for. The click that opened it did that.
  const window = await windowBounds(ctx);
  if (area === "display") {
    // The one area taken by place: everything on the display, other windows included.
    const display = displayOf(ctx, window);
    const region = [display.x, display.y, display.width, display.height].map(Math.round).join(",");
    run(ctx, `the display couldn't be captured; the region was ${region}`, "screencapture", ["-x", "-R", region, path]);
    return;
  }
  if (area === "window" && target === undefined) return captureWindow(ctx, path, window, null);

  const origin = await pageOrigin(ctx, window);
  const size = await ctx.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // No more than the page shows in the window: a viewport emulated
  // larger than the window is cut off by it.
  const page = clip({ ...origin, ...size }, window);
  if (target === undefined) return captureWindow(ctx, path, window, page);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) return ctx.fail(`${target} isn't visible, so it has no place on screen`);
  const element = clip({ x: origin.x + box.x, y: origin.y + box.y, width: box.width, height: box.height }, page);
  if (element.width <= 0 || element.height <= 0) return ctx.fail(`${target} is outside what the window shows`);
  return captureWindow(ctx, path, window, element);
}

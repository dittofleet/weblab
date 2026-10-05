// Reading and capturing: the page as text, and screenshots.
import { withoutCursor } from "../cursor.ts";
import { readFileSync, writeFileSync } from "node:fs";
import type { Locator } from "playwright-core";
export const LOOK_FORMATS = ["refs", "plain", "text", "html"] as const;
export type LookFormat = (typeof LOOK_FORMATS)[number];
import { StepFailure, UsageError } from "../errors.ts";
import { captureScreen, SCREEN_AREAS, type Rect, type ScreenArea } from "../screen.ts";
import type { Action, ActionContext } from "../types.ts";
import { arg, bad, isObject } from "./args.ts";
import { readyArg, waitReady } from "./navigation.ts";
import { ariaTree, hasTarget, locate } from "./target.ts";


/** The page, or one element, as text: a tree with refs, a plain tree, its words, or its markup. */
export async function readPage(ctx: ActionContext, root: Locator, format: LookFormat, depth?: number): Promise<string> {
  const read = { timeout: 5000 };
  try {
    switch (format) {
      case "refs":
        return await ariaTree(ctx, root, { refs: true, depth, ...read });
      case "plain":
        return await ariaTree(ctx, root, { refs: false, depth, ...read });
      case "text":
        return await root.innerText(read);
      case "html":
        return await root.evaluate((element) => element.outerHTML, undefined, read);
    }
  } catch (error) {
    if (error instanceof UsageError || !/Timeout/.test(String(error))) throw error;
    throw new StepFailure(`nothing on the page matches ${root} (waited ${read.timeout / 1000} s)`);
  }
}

// Images below the fold wait to load until they are scrolled near,
// which a full-page capture never does: load them all first, for as
// long as the step may take, and say if some never came.
async function loadLazyImages(ctx: ActionContext): Promise<void> {
  const pending = await ctx.page
    .evaluate(async (timeout) => {
      const lazy = [...document.querySelectorAll("img[loading=lazy]")] as HTMLImageElement[];
      for (const image of lazy) image.loading = "eager";
      const loaded = (image: HTMLImageElement) =>
        new Promise((done) => {
          if (image.complete) return done(null);
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
        });
      await Promise.race([Promise.all(lazy.map(loaded)), new Promise((done) => setTimeout(done, timeout))]);
      return lazy.filter((image) => !image.complete).length;
    }, Math.max(ctx.timeout - 2000, 1000))
    .catch(() => 0);
  if (pending > 0) ctx.note(`${pending} lazy image${pending === 1 ? " was" : "s were"} still loading when the shot was taken`);
}

// How far apart two pixels' colours may be (of 255, in any channel) and still count as the same.
const SAME_COLOUR = 16;

// Compares a screenshot with one taken before, pixel by pixel. The
// browser does the work, as it can read a PNG and nothing else here can.
// What differs is drawn in red over a faded copy, and kept beside the shot.
async function compare(ctx: ActionContext, shot: string, { file: before, png }: { file: string; png: string }, name: string, tolerance: number): Promise<void> {
  const found = await ctx.page.evaluate(
    async ({ now, then, same }) => {
      const read = (data: string) => {
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        return createImageBitmap(new Blob([bytes], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      };
      const [a, b] = await Promise.all([read(now), read(then)]);
      if (a.width !== b.width || a.height !== b.height) return { sizes: [a.width, a.height, b.width, b.height] };
      const canvas = new OffscreenCanvas(a.width, a.height);
      const pen = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      const pixels = (image: ImageBitmap) => {
        pen.clearRect(0, 0, a.width, a.height);
        pen.drawImage(image, 0, 0);
        return pen.getImageData(0, 0, a.width, a.height);
      };
      const [first, second] = [pixels(a).data, pixels(b)];
      const out = second.data;
      let different = 0;
      for (let at = 0; at < out.length; at += 4) {
        let apart = 0;
        for (let channel = 0; channel < 4; channel += 1) apart = Math.max(apart, Math.abs((first[at + channel] as number) - (out[at + channel] as number)));
        if (apart > same) {
          different += 1;
          out.set([255, 0, 0, 255], at);
        } else {
          // Faded, so what differs stands out.
          for (let channel = 0; channel < 3; channel += 1) out[at + channel] = 255 - (255 - (out[at + channel] as number)) / 4;
          out[at + 3] = 255;
        }
      }
      if (different === 0) return { different, total: out.length / 4 };
      pen.putImageData(second, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let text = "";
      for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return { different, total: out.length / 4, diff: btoa(text) };
    },
    { now: readFileSync(shot).toString("base64"), then: png, same: SAME_COLOUR },
  );
  if ("sizes" in found) {
    const [width, height, wasWidth, wasHeight] = found.sizes as number[];
    throw new StepFailure(`the shot is ${width}x${height}, and ${before} is ${wasWidth}x${wasHeight}`);
  }
  if (found.different / found.total <= tolerance) return;
  const diff = ctx.artifacts.path("shots", `${name}.diff`, "png");
  writeFileSync(diff, Buffer.from(found.diff as string, "base64"));
  ctx.artifacts.add(diff);
  const share = ((found.different / found.total) * 100).toFixed(found.different / found.total < 0.001 ? 3 : 1);
  throw new StepFailure(`the shot differs from ${before} in ${found.different} of ${found.total} pixels (${share}%); what differs is in red in ${diff}`);
}

// A part of the page to capture: from the viewport's top left, or the page's with fullPage.
const isClip = (clip: unknown): clip is Rect =>
  isObject(clip) &&
  [clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) &&
  (clip.width as number) > 0 &&
  (clip.height as number) > 0;

const EXTENSIONS: Record<LookFormat, string> = { refs: "yml", plain: "yml", text: "txt", html: "html" };

export const captureSteps: Record<string, Action> = {
  look: Object.assign(async (ctx: ActionContext, args: unknown) => {
    const options = isObject(args) ? args : typeof args === "string" ? { as: args } : {};
    const format = (options.format ?? "refs") as LookFormat;
    if (!LOOK_FORMATS.includes(format)) bad("look", `a format of ${LOOK_FORMATS.join(", ")}`);
    const root = hasTarget(options) ? locate(ctx, options, "look") : ctx.page.locator("body");
    const text = await readPage(ctx, root, format, options.depth as number | undefined);
    // It's handed back as the step's value; named, it's kept as a file too.
    if (options.as !== undefined) {
      const path = ctx.artifacts.path("looks", String(options.as), EXTENSIONS[format]);
      writeFileSync(path, `${text}\n`);
      ctx.artifacts.addFile(path);
    }
    return text;
  }, { prints: true }),

  shot: async (ctx, args) => {
    const { as, fullPage, animations, screen, matches, tolerance, clip } = arg<{ as?: string; fullPage?: boolean; animations?: boolean; screen?: boolean | ScreenArea; matches?: string; tolerance?: number; clip?: Rect }>(args, "as", "shot");
    if (matches !== undefined && typeof matches !== "string") bad("shot", "matches to be the path of a screenshot taken before");
    if (tolerance !== undefined && !(typeof tolerance === "number" && tolerance >= 0 && tolerance <= 1)) bad("shot", "tolerance to be the share of pixels that may differ, from 0 to 1");
    if (as === undefined) {
      // `name` is an element's accessible name, beside `role`; what the file is called is `as`.
      bad("shot", `what to call it: "home", or { as, fullPage, animations, screen, ...target }`);
    }
    if (clip !== undefined && !isClip(clip)) bad("shot", "clip to be { x, y, width, height } in CSS pixels, with a width and height above 0");
    const path = ctx.artifacts.path("shots", String(as), "png");
    // Read before the new shot is written, which may be to the very same file.
    const before = matches === undefined ? undefined : { file: await ctx.resolveFile(matches), png: "" };
    if (before !== undefined) before.png = readFileSync(before.file).toString("base64");
    // The real screen, with what the OS draws over the page: an open <select>, a context menu.
    if (screen !== undefined && screen !== false) {
      // `true` is short for the usual choice, the page.
      const area = screen === true ? "page" : screen;
      if (!SCREEN_AREAS.includes(area)) bad("shot", `screen to be "page" (or true), "window" or "display"`);
      if (fullPage === true) bad("shot", "screen or fullPage, not both: the screen shows only what's in the window");
      if (clip !== undefined) bad("shot", "screen or clip, not both");
      await withoutCursor(ctx.page, ctx.video, () => captureScreen(ctx, path, area, hasTarget(args) ? locate(ctx, args, "shot") : undefined));
    } else {
      // Animations are finished (or, endless ones, reset) for the capture,
      // so a shot never catches a page mid-fade, unless asked to.
      const options = { path, animations: animations === true ? ("allow" as const) : ("disabled" as const) };
      // A bare string is the name, so an element is only named in the object form.
      if (isObject(args) && hasTarget(args)) {
        if (clip !== undefined) bad("shot", "a target or clip, not both: a target is captured whole");
        await withoutCursor(ctx.page, ctx.video, () => locate(ctx, args, "shot").screenshot(options));
      } else {
        if (fullPage === true) await loadLazyImages(ctx);
        await withoutCursor(ctx.page, ctx.video, () => ctx.page.screenshot({ ...options, fullPage: fullPage === true, clip }));
      }
    }
    ctx.artifacts.add(path);
    if (before !== undefined) await compare(ctx, path, before, String(as), tolerance ?? 0);
  },

  video: async (ctx, args) => {
    if (args === "stop") {
      if (!ctx.video) ctx.fail(`nothing is being recorded. Start with { "video": "start" }`);
      for (const path of await ctx.film.stop(ctx.page)) ctx.artifacts.addFile(path);
      return;
    }
    if (args !== "start" && !isObject(args)) bad("video", `"start", "stop", or { as, ready } to start`);
    const { as, ready } = isObject(args) ? args : {};
    if (as !== undefined && typeof as !== "string") bad("video", "as to be what to call the video");
    if (ctx.video) ctx.fail(`a video is being recorded already. Stop it first with { "video": "stop" }`);
    // Not a blank page that is still loading: the video starts with the app on it.
    await waitReady(ctx, readyArg("video", ready));
    await ctx.film.start(ctx.page, as);
    // The drawn cursor is where the pointer is, from the first frame.
    await ctx.page.mouse.move(ctx.mouse.x, ctx.mouse.y);
  },
};

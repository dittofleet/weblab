// Recording on demand: the video step starts filming the tab steps act
// on, and stops again. Each take is a file of its own, and a tab the
// steps move to during a take gets one beside it.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Disposable, Page } from "playwright-core";
import { CURSOR, REMOVE_CURSOR } from "./cursor.ts";
import { briefError, SetupError } from "./errors.ts";
import { slug } from "./state.ts";

// Held on the last frame of a take so the outcome is readable.
const TAIL_MS = 2000;

export type Film = {
  /** True while a take is being recorded. */
  readonly rolling: boolean;
  /** Starts a take on the tab. `as` names its file. */
  start(page: Page, as?: string): Promise<void>;
  /** During a take, films a tab the steps moved to as well. */
  follow(page: Page): Promise<void>;
  /** Before weblab closes a tab: its recording is finished, since a closed tab's is lost. */
  closing(page: Page): Promise<void>;
  /** Ends the take, holding the last frame of `page` a moment first. The files it wrote. */
  stop(page: Page): Promise<string[]>;
};

/** Takes for one session: written to `<dir>/videos/<files>.webm`, then `<files>-take2.webm`, ... */
export function filming(dir: string, files: string, say: (line: string) => void): Film {
  type Filmed = { page: Page; path: string; cursor: Disposable; done?: boolean; kept?: boolean };
  let take: { name: string; tabs: Filmed[] } | null = null;
  let takes = 0;

  // The tab is left without the cursor, as it was before the take: in
  // every frame, since the init script put it in frames loaded meanwhile.
  async function uncursor(page: Page, cursor: Disposable): Promise<void> {
    await cursor.dispose().catch(() => {});
    await Promise.all(page.frames().map((frame) => frame.evaluate(REMOVE_CURSOR).catch(() => {})));
  }

  async function finish(filmed: Filmed): Promise<void> {
    if (filmed.done) return;
    filmed.done = true;
    const { page, path, cursor } = filmed;
    await page.screencast.stop().catch(() => {});
    await uncursor(page, cursor);
    filmed.kept = existsSync(path);
    if (filmed.kept) await mp4Beside(path, say);
  }

  async function film(page: Page): Promise<void> {
    if (take === null || take.tabs.some((filmed) => filmed.page === page)) return;
    const index = take.tabs.length;
    const path = join(dir, "videos", `${take.name}${index === 0 ? "" : `-tab${index}`}.webm`);
    // The drawn cursor goes in this tab alone: an attached browser's other tabs aren't weblab's.
    const cursor = await page.addInitScript(CURSOR);
    await page.evaluate(CURSOR).catch(() => {});
    const frame = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null));
    await page.screencast.start({ path, ...(frame === null || frame.width === 0 ? {} : { size: frame }) }).catch(async (error) => {
      // Playwright counts a screencast that failed to start as started: stopped, so a later take can.
      await page.screencast.stop().catch(() => {});
      await uncursor(page, cursor);
      throw new SetupError(`could not record the tab: ${briefError(error)}`);
    });
    take.tabs.push({ page, path, cursor });
  }

  return {
    get rolling() {
      return take !== null;
    },
    async start(page, as) {
      takes += 1;
      mkdirSync(join(dir, "videos"), { recursive: true });
      take = { name: as === undefined ? (takes === 1 ? files : `${files}-take${takes}`) : `${files}-${slug(as)}`, tabs: [] };
      try {
        await film(page);
      } catch (error) {
        take = null;
        throw error;
      }
    },
    follow: film,
    async closing(page) {
      const filmed = take?.tabs.find((one) => one.page === page);
      if (filmed !== undefined) await finish(filmed);
    },
    async stop(page) {
      if (take === null) return [];
      const { tabs } = take;
      await page.waitForTimeout(TAIL_MS).catch(() => {});
      take = null;
      await Promise.all(tabs.map(finish));
      return tabs.filter((filmed) => filmed.kept).map((filmed) => filmed.path);
    },
  };
}

// Optional: with FFMPEG set to an ffmpeg binary an mp4 lands beside the
// webm. Run alongside, so other sessions' steps go on meanwhile.
async function mp4Beside(webm: string, say: (line: string) => void): Promise<void> {
  const ffmpeg = process.env.FFMPEG;
  if (!ffmpeg) return;
  try {
    await promisify(execFile)(ffmpeg, [
      "-y", "-loglevel", "error", "-i", webm,
      "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      webm.replace(/\.webm$/, ".mp4"),
    ]);
  } catch (error) {
    // The webm is the recording; the mp4 is a convenience.
    say(`mp4 not written: ${briefError(error)}`);
  }
}

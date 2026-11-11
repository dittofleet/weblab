// Playwright records through its own build of ffmpeg, a small download
// that isn't part of weblab. The installers and `weblab update` fetch it
// ahead of time, and a take that finds it missing fetches it then.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { registry, utils } from "playwright-core/lib/coreBundle";

let fetching: Promise<void> | null = null;

/** Puts the ffmpeg this weblab's Playwright records with where Playwright looks for it, unless it is there. */
export const ensureFfmpeg = (): Promise<void> => {
  fetching ??= fetchFfmpeg().finally(() => {
    fetching = null;
  });
  return fetching;
};

async function fetchFfmpeg(): Promise<void> {
  const ffmpeg = registry.registry.findExecutable("ffmpeg");
  const executable = ffmpeg.executablePath();
  if (existsSync(executable)) return;
  const [url] = ffmpeg.downloadURLs;
  const response = await fetch(url as string, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  mkdirSync(dirname(ffmpeg.directory), { recursive: true });
  // Unpacked beside its place, then moved there: never half a build.
  const staged = `${ffmpeg.directory}.${process.pid}`;
  const zip = `${staged}.zip`;
  try {
    await Bun.write(zip, response);
    await utils.extractZip(zip, { dir: staged });
    renameSync(staged, ffmpeg.directory);
    chmodSync(executable, 0o755);
  } catch (error) {
    // Another weblab fetching it at the same moment got there first.
    if (!existsSync(executable)) throw error;
  } finally {
    rmSync(zip, { force: true });
    rmSync(staged, { recursive: true, force: true });
  }
}

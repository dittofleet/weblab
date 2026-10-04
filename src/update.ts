// Keeping weblab current: `weblab update` installs the latest release
// over this binary, and once a day a running weblab looks for a newer
// one, so a reply can say there is one.
import { spawnSync } from "node:child_process";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readRecord, writeRecord } from "./state.ts";
import { VERSION } from "./version.ts";

const REPO = "dittofleet/weblab";
const DAY_MS = 24 * 60 * 60_000;

// A compiled binary is what there is to replace; run from source, the checkout is.
const compiled = () => process.argv[1]?.startsWith("/$bunfs/") === true;

/** True when version `a` is newer than `b`: 0.10.0 is newer than 0.9.1. */
export function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((version) => version.split(".").map((part) => Number.parseInt(part, 10) || 0));
  for (let at = 0; at < 3; at += 1) {
    if ((x?.[at] ?? 0) !== (y?.[at] ?? 0)) return (x?.[at] ?? 0) > (y?.[at] ?? 0);
  }
  return false;
}

// The latest release's version, read from where its page redirects to:
// no API, so no rate limit to run into.
async function latestVersion(): Promise<string> {
  const response = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const tag = /\/tag\/v(\d+\.\d+\.\d+)$/.exec(response.headers.get("location") ?? "")?.[1];
  if (tag === undefined) throw new Error("could not tell what the latest release is");
  return tag;
}

/** `weblab update`: installs the latest release in place of this binary. Returns the exit code. */
export async function update(): Promise<number> {
  if (!compiled()) {
    console.log("weblab is running from source here; update the checkout instead (git pull).");
    return 1;
  }
  const latest = await latestVersion();
  if (!newer(latest, VERSION)) {
    console.log(`weblab ${VERSION} is the latest.`);
    return 0;
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const url = `https://github.com/${REPO}/releases/download/v${latest}/weblab-darwin-${arch}`;
  console.log(`Downloading ${url}...`);
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok) throw new Error(`the download failed: ${response.status} ${response.statusText}`);
  // Beside the binary, so putting it in place is a rename: whole, or not at all.
  const staged = `${process.execPath}.update-${process.pid}`;
  try {
    writeFileSync(staged, Buffer.from(await response.arrayBuffer()));
    chmodSync(staged, 0o755);
    // Tried before it replaces anything.
    const tried = spawnSync(staged, ["--version"], { encoding: "utf8" });
    if (tried.status !== 0 || tried.stdout.trim() !== latest) throw new Error(`the downloaded binary did not run as ${latest}`);
    renameSync(staged, process.execPath);
  } finally {
    rmSync(staged, { force: true });
  }
  writeRecord("update", { checkedAt: Date.now(), latest });
  console.log(`Updated weblab ${VERSION} to ${latest}. MCP clients pick it up when they next start it.`);
  return 0;
}

type Checked = { checkedAt: number; latest: string };

/**
 * A line saying a newer release is out, when the last look found one;
 * null otherwise. Looks again, in the background, when the last look
 * was more than a day ago. Never waits, and never fails.
 */
export function updateNote(): string | null {
  if (!compiled() || process.env.WEBLAB_NO_UPDATE_CHECK) return null;
  const checked = readRecord<Checked>("update");
  if (checked === null || Date.now() - checked.checkedAt > DAY_MS) {
    void latestVersion().then(
      (latest) => writeRecord("update", { checkedAt: Date.now(), latest } satisfies Checked),
      () => {},
    );
  }
  if (checked === null || !newer(checked.latest, VERSION)) return null;
  return `note: weblab ${checked.latest} is out (this is ${VERSION}). Update with: weblab update`;
}

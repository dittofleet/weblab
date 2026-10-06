import { type ChildProcess, spawn } from "node:child_process";

// Whatever is still open when the process is told to go: its sessions'
// browsers, a server weblab started, a lock. A signal runs the same
// teardown a clean exit does, so nothing is left behind.
const cleanups: (() => Promise<void> | void)[] = [];
let running: Promise<void> | null = null;

export const onTeardown = (cleanup: () => Promise<void> | void) => {
  cleanups.push(cleanup);
};

/**
 * Runs every cleanup once, newest first. A later caller (a second
 * Ctrl+C, a signal during a clean exit) waits for the same pass rather
 * than exiting halfway through it.
 */
export function teardown(): Promise<void> {
  running ??= (async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Keep going: the rest still has to be released.
      }
    }
  })();
  return running;
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    void teardown().then(() => process.exit(code));
  });
}

// A process killed outright (SIGKILL, a crash, the OOM killer) runs none
// of the above. So once weblab starts something of its own (a browser, a
// server, or a share in one) a small process of weblab's own watches over
// it: it holds a pipe from this one, which closes however this one ends,
// and then stops whatever this one left (see reaper.ts). It is in a group
// of its own, so a signal to this one's group doesn't reach it.
let reaper: ChildProcess | null = null;

export function watchOver(): void {
  if (reaper !== null) return;
  // Compiled, weblab is its own executable; from source, bun runs main.ts.
  const self = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
  reaper = spawn(process.execPath, [...self, "--reap", String(process.pid)], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    cwd: "/",
  });
  reaper.on("error", () => {});
  // It doesn't keep this one running.
  reaper.unref();
  (reaper.stdin as unknown as { unref?(): void } | null)?.unref?.();
}

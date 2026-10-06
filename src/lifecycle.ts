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
    await dismissWatcher();
  })();
  return running;
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    void teardown().then(() => process.exit(code));
  });
}

// A process killed outright (SIGKILL, a crash, the OOM killer) runs none
// of the above. So a watcher is started beside every weblab that serves:
// a shell holding a pipe from this process, which closes however this one
// ends. A teardown that ran to the end tells it so, and it just goes;
// otherwise it runs weblab's sweep (reaper.ts), which stops whatever this
// one left. It is in a group of its own, so a signal to this one's group
// doesn't reach it, and it is only a shell until it has something to do.
let watcher: ChildProcess | null = null;

export function watchOver(): void {
  if (watcher !== null) return;
  // Compiled, weblab is its own executable; from source, bun runs main.ts.
  const self = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
  // `read` blocks until a line or the end of the pipe: the whole wait is the shell's own.
  watcher = spawn("/bin/sh", ["-c", 'read -r line; [ "$line" = done ] || exec "$0" "$@"', process.execPath, ...self, "--sweep"], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    cwd: "/",
  });
  watcher.on("error", () => {});
  watcher.stdin?.on("error", () => {});
  // It doesn't keep this one running.
  watcher.unref();
  (watcher.stdin as unknown as { unref?(): void } | null)?.unref?.();
}

// Written out before the process exits: a write left in the pipe would be lost.
const dismissWatcher = () =>
  new Promise<void>((done) => {
    if (watcher?.stdin == null || watcher.stdin.destroyed) return done();
    watcher.stdin.end("done\n", done);
  });

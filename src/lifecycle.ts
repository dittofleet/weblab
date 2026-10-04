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

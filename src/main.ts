#!/usr/bin/env bun
// weblab is an MCP server over stdio: a client starts it, and it holds
// that client's sessions until the client goes.
import { Console } from "node:console";
import { VERSION } from "./version.ts";

const HELP = `weblab ${VERSION}: an MCP server for testing and exploring web apps in a real browser.

It speaks MCP over stdio, so it is started by an MCP client, not by hand:

  claude mcp add weblab -- weblab
  codex mcp add weblab -- weblab

or, in a client's JSON config:  { "command": "weblab" }

Its tools: new (open a session), run (run steps on one), end, list, docs.

  weblab update      install the latest release
  weblab --version   print this one's version`;

// A weblab started from an Electron app (an editor, an agent's host)
// inherits ELECTRON_RUN_AS_NODE, which means nothing to weblab and would
// make an Electron app it starts run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const [flag, ...args] = process.argv.slice(2);
if (flag === "--sweep-after") {
  // Run by weblab's own watcher (lifecycle.ts) once a weblab has ended; only what it needs is loaded.
  const { sweepAfter } = await import("./reaper.ts");
  await sweepAfter(Number(args[0]), args[1] || null);
  process.exit(0);
} else if (flag === "--version" || flag === "-v") {
  console.log(VERSION);
} else if (flag === "update") {
  const { update } = await import("./update.ts");
  process.exitCode = await update().catch((error) => {
    console.error(`weblab: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  });
} else if (flag !== undefined) {
  console.log(HELP);
  process.exitCode = flag === "--help" || flag === "-h" ? 0 : 1;
} else {
  // stdout carries the protocol and nothing else: whatever code a step
  // runs prints goes to stderr.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr }) as unknown as typeof console;

  const [{ serveStdio }, { onTeardown, teardown }, { createServer }, { sweep }, { shutdown }] = await Promise.all([
    import("@modelcontextprotocol/server/stdio"),
    import("./lifecycle.ts"),
    import("./mcp.ts"),
    import("./reaper.ts"),
    import("./sessions.ts"),
  ]);

  // Whatever a weblab that was killed left running, if its watcher didn't get to it.
  await sweep();

  // Sessions end with the process: browsers closed, videos written, servers let go of.
  onTeardown(shutdown);
  const handle = serveStdio(() => createServer(VERSION), { onerror: (error) => console.error(`weblab: ${error.message}`) });
  const leave = () => void teardown().then(() => handle.close().catch(() => {})).then(() => process.exit(0));
  // The client going away is the end: its stdin closes.
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
}

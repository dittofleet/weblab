#!/usr/bin/env bun
// weblab is an MCP server over stdio: a client starts it, and it holds
// that client's sessions until the client goes.
import { Console } from "node:console";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import manifest from "../package.json" with { type: "json" };
import { onTeardown, teardown } from "./lifecycle.ts";
import { createServer } from "./mcp.ts";
import { sweepServers } from "./server.ts";
import { shutdown } from "./sessions.ts";

const HELP = `weblab ${manifest.version}: an MCP server for testing and exploring web apps in a real browser.

It speaks MCP over stdio, so it is started by an MCP client, not by hand:

  claude mcp add weblab -- weblab
  codex mcp add weblab -- weblab

or, in a client's JSON config:  { "command": "weblab" }

Its tools: new (open a session), run (run steps on one), end, list, docs.`;

const [flag] = process.argv.slice(2);
if (flag === "--version" || flag === "-v") {
  console.log(manifest.version);
} else if (flag !== undefined) {
  console.log(HELP);
  process.exitCode = flag === "--help" || flag === "-h" ? 0 : 1;
} else {
  // stdout carries the protocol and nothing else: whatever code a step
  // runs prints goes to stderr.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr }) as unknown as typeof console;

  // Whatever a weblab that was killed left running.
  await sweepServers().catch(() => {});

  // Sessions end with the process: browsers closed, videos written, servers let go of.
  onTeardown(shutdown);
  const handle = serveStdio(() => createServer(manifest.version), { onerror: (error) => console.error(`weblab: ${error.message}`) });
  const leave = () => void teardown().then(() => handle.close().catch(() => {})).then(() => process.exit(0));
  // The client going away is the end: its stdin closes.
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
}

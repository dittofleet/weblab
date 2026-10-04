// An Electron app's main process, joined over the Node debugger it was
// started with (`--inspect=9229`): what the `electron` step runs code in.
//
// Its windows are joined over Chromium's own port (`attach`); the main
// process, which owns the windows, menus, dialogs and IPC, has a port of
// its own and speaks the same protocol's Runtime domain. Nothing is
// opened that the app wasn't started with: weblab never turns the
// debugger on itself.
import type { BrowserContext } from "playwright-core";
import { briefError, SetupError, StepFailure, UsageError } from "./errors.ts";

/** The main process of the app a session is attached to. */
export type MainProcess = {
  /** Its process id: the same as the browser process of the app's windows. */
  readonly pid: number;
  /** Runs code in it, with `electron` and its modules in scope, and hands back the value. */
  evaluate(code: string, timeout: number): Promise<unknown>;
  /** Puts back what the session's code stubbed, and lets go of it. The app keeps running. */
  close(): Promise<void>;
};

// What code is handed by name, beside `electron` itself and `require`.
const MODULES = ["app", "BrowserWindow", "webContents", "ipcMain", "dialog", "Menu", "shell", "session", "clipboard", "nativeTheme", "screen"];

// Where a session's stubs keep what to put back: one property of the
// app's global, under a symbol of weblab's, gone once nothing is stubbed.
const STUBS = `globalThis[Symbol.for("weblab.stubs")]`;

// `stub(object, name, replacement)`: the replacement stands in for the
// rest of the session, and the original is put back when it ends,
// unless something else has replaced it since.
const stubFor = (session: string) =>
  `(object, name, replacement) => { const original = object[name]; ((${STUBS} ??= {})[${JSON.stringify(session)}] ??= []).push(() => { if (object[name] === replacement) object[name] = original; }); object[name] = replacement; }`;

// Puts back a session's stubs, newest first.
const unstub = (session: string) =>
  `(() => { const all = ${STUBS}; const mine = all?.[${JSON.stringify(session)}] ?? []; for (const undo of mine.reverse()) { try { undo(); } catch {} } if (all) { delete all[${JSON.stringify(session)}]; if (Object.keys(all).length === 0) delete ${STUBS}; } })()`;

// The code goes in a block of its own, inside the one that hands it its
// names, so what it declares with const, let and class stays in it and
// may reuse those names. A block's value is its last statement's, so
// `const n = app.getName(); n` hands back the name.
const wrapped = (code: string, session: string) =>
  `{ const electron = require("electron"); const { ${MODULES.join(", ")} } = electron; const stub = ${stubFor(session)}; { ${code}\n} }`;

// Run in the app on what the code handed back: data as it is, and what
// isn't data as what it is, at any depth: `[BrowserWindow]`, `[Function save]`.
const AS_DATA = `function () {
  const path = new Set();
  const walk = (value, depth) => {
    if (typeof value === "function") return "[Function" + (value.name ? " " + value.name : "") + "]";
    if (typeof value === "bigint") return value + "n";
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (value === null || typeof value !== "object") return value;
    if (path.has(value)) return "[Circular]";
    if (depth > 20) return "[...]";
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof Error) return value.name + ": " + value.message;
    path.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
      if (value instanceof Set) return [...value].map((item) => walk(item, depth + 1));
      if (value instanceof Map) {
        const entries = [...value].map(([key, item]) => [walk(key, depth + 1), walk(item, depth + 1)]);
        return entries.every(([key]) => typeof key === "string") ? Object.fromEntries(entries) : entries;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) return "[" + ((value.constructor && value.constructor.name) || "Object") + "]";
      const out = {};
      for (const key of Object.keys(value)) {
        try {
          out[key] = walk(value[key], depth + 1);
        } catch (error) {
          out[key] = "[threw " + error + "]";
        }
      }
      return out;
    } finally {
      path.delete(value);
    }
  };
  return walk(this, 0);
}`;

/** The process of the browser an attached context is in: an Electron app's main process. Null if it won't say. */
export async function browserProcess(context: BrowserContext): Promise<number | null> {
  const browser = context.browser();
  if (browser === null) return null;
  const cdp = await browser.newBrowserCDPSession().catch(() => null);
  if (cdp === null) return null;
  try {
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo" as never)) as { processInfo: { type: string; id: number }[] };
    return processInfo.find((one) => one.type === "browser")?.id ?? null;
  } catch {
    return null;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** `9229`, `localhost:9229`, or a full http:// or ws:// address. */
const endpoint = (inspect: string) =>
  /^\d+$/.test(inspect) ? `http://127.0.0.1:${inspect}` : /^[a-z]+:\/\//.test(inspect) ? inspect : `http://${inspect}`;

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

type Target = { type?: string; webSocketDebuggerUrl?: string };

// The debugger's own address for the process, asked of its port.
async function socketAddress(inspect: string): Promise<string> {
  const base = endpoint(inspect);
  if (base.startsWith("ws")) return base;
  let targets: Target[];
  try {
    targets = (await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as Target[];
  } catch (error) {
    throw new SetupError(`could not reach the main process at ${inspect}: ${briefError(error)} (the app has to be started with --inspect=<port>)`);
  }
  const node = targets.find((target) => target.type === "node");
  if (node?.webSocketDebuggerUrl !== undefined) return node.webSocketDebuggerUrl;
  if (targets.some((target) => target.type === "page" || target.type === "browser")) {
    throw new SetupError(`${inspect} is the app's Chromium debugging port, which is for attach; inspect takes the main process's Node one, from --inspect=<port>`);
  }
  throw new SetupError(`${inspect} has no Node process to join`);
}

// A value as the debugger describes it.
type Remote = {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: Preview;
};
type Preview = {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: { name: string; type: string; subtype?: string; value?: string; valuePreview?: Preview }[];
  entries?: { key?: Preview; value: Preview }[];
};

// A logged object as Node's console would print it, from the debugger's preview of it.
function previewText(preview: Preview): string {
  const more = preview.overflow ? ", ..." : "";
  if (preview.entries !== undefined) {
    const entries = preview.entries.map(({ key, value }) => (key === undefined ? previewText(value) : `${previewText(key)} => ${previewText(value)}`));
    return `${preview.description} { ${entries.join(", ")}${more} }`;
  }
  if (preview.type !== "object" || preview.subtype === "null") return preview.description ?? "";
  const values = preview.properties.map((property) => {
    const value = property.valuePreview !== undefined ? previewText(property.valuePreview) : property.type === "string" ? JSON.stringify(property.value) : (property.value ?? "");
    return preview.subtype === "array" ? value : `${property.name}: ${value}`;
  });
  if (preview.subtype === "array") return `[ ${values.join(", ")}${more} ]`;
  const kind = preview.description === "Object" ? "" : `${preview.description} `;
  return `${kind}{ ${values.join(", ")}${more} }`;
}

// One argument of a console call as it reads: a string as it is, anything else as Node would print it.
function argText(arg: Remote): string {
  if (arg.type === "string") return String(arg.value);
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.type === "undefined") return "undefined";
  if (arg.type === "function") {
    const name = /^(?:async\s+)?(?:function\*?|class)\s+([\w$]+)/.exec(arg.description ?? "")?.[1];
    return name === undefined ? "[Function]" : `[Function ${name}]`;
  }
  if (arg.preview !== undefined) return previewText(arg.preview);
  return arg.description ?? JSON.stringify(arg.value);
}

// A console call as it reads: `%s` and its kin filled in from the arguments, `%c` dropped.
function consoleText(args: Remote[]): string {
  const [first, ...rest] = args;
  if (first === undefined) return "";
  if (first.type !== "string" || !String(first.value).includes("%")) return args.map(argText).join(" ");
  const filled = String(first.value).replace(/%([sdifoOc%])/g, (whole, kind: string) => {
    if (kind === "%") return "%";
    const arg = rest.shift();
    if (arg === undefined) return whole;
    if (kind === "c") return "";
    if (kind === "d" || kind === "i") return String(Math.trunc(Number(arg.value)));
    if (kind === "f") return String(Number(arg.value));
    return argText(arg);
  });
  return [filled, ...rest.map(argText)].join(" ");
}

// An error as the step reports it: its own frames, without the ones of the code weblab wrapped.
const errorText = (description: string) => description.split("\n").filter((line) => !/^\s+at .*<anonymous>/.test(line)).join("\n");

/**
 * Joins the main process at `inspect` and checks that it is Electron's.
 * What it logs from now on goes to `log`. `session` names what the code stubs.
 */
export async function joinMainProcess(inspect: string, session: string, log: (type: string, text: string) => void): Promise<MainProcess> {
  const socket = new WebSocket(await socketAddress(inspect));
  await new Promise<void>((done, failed) => {
    socket.onopen = () => done();
    socket.onerror = () => failed(new SetupError(`could not join the main process at ${inspect}`));
  });
  // Once it goes, it is gone: an app that quit or restarted is another session's.
  let gone: string | null = null;
  let next = 0;
  const waiting = new Map<number, { done(message: Message): void; failed(error: Error): void }>();
  // Only what it logs from now on: the debugger also hands over what it kept from before.
  const since = Date.now();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      waiting.get(message.id)?.done(message);
      waiting.delete(message.id);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.timestamp >= since) {
      log(message.params.type, consoleText(message.params.args));
    } else if (message.method === "NodeRuntime.waitingForDisconnect") {
      // The app is exiting, and waits for its debugger clients to let go before it can.
      socket.close();
    }
  };
  socket.onclose = () => {
    gone ??= "the app's main process went away: it quit or restarted. End the session and open it again";
    for (const [id, one] of waiting) {
      waiting.delete(id);
      one.failed(new StepFailure(gone));
    }
  };

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Message>((done, failed) => {
      if (gone !== null) return failed(new StepFailure(gone));
      const id = (next += 1);
      waiting.set(id, { done, failed });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const GROUP = "weblab";

  // What the code handed back, or threw, as data.
  async function asData(remote: Remote): Promise<unknown> {
    if (remote.type === "undefined") return undefined;
    if (remote.unserializableValue !== undefined) return remote.unserializableValue;
    if (remote.objectId === undefined) return remote.value;
    const copied = await send("Runtime.callFunctionOn", { objectId: remote.objectId, functionDeclaration: AS_DATA, returnByValue: true });
    return copied.result?.result?.value ?? remote.description;
  }

  async function failure(exception: Remote | undefined, text: string): Promise<Error> {
    if (exception === undefined) return new StepFailure(text);
    if (exception.className === "SyntaxError") {
      const hint = /Illegal return/.test(exception.description ?? "") ? " (an electron step hands back its last statement's value; it needs no return)" : "";
      return new UsageError(`electron: ${errorText(exception.description ?? text)}${hint}`);
    }
    if (exception.subtype === "error") return new StepFailure(errorText(exception.description ?? text));
    return new StepFailure(`threw ${JSON.stringify(await asData(exception).catch(() => exception.description))}`);
  }

  async function evaluate(code: string, timeout: number): Promise<unknown> {
    // Read first as written, so a mistake is said about the code itself, not the block it is put in.
    // A script can't await, which a step can: code that reads as an async
    // function's body is no mistake, and one that awaits is told as that.
    const compile = async (expression: string) =>
      (await send("Runtime.compileScript", { expression, sourceURL: "", persistScript: false })).result?.exceptionDetails as { text: string; exception?: Remote } | undefined;
    const asScript = await compile(code);
    if (asScript !== undefined) {
      const asBody = await compile(`(async () => {\n${code}\n})`);
      const mistake = /\bawait\b/.test(code) ? asBody : asScript;
      if (asBody !== undefined && mistake !== undefined) throw await failure(mistake.exception, mistake.text);
    }
    const begun = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Past the timeout, code is either busy (a loop after an await, which
    // the debugger's own timeout doesn't cover) or waiting. Busy code keeps
    // the event loop from turning, and is stopped; code that waits is left.
    // Never stopped on a guess: a stop the app isn't busy for lands on its next task.
    const late = new Promise<never>((_, failed) => {
      timer = setTimeout(async () => {
        const turned = send("Runtime.evaluate", { expression: "new Promise((done) => setImmediate(() => done(true)))", awaitPromise: true, returnByValue: true });
        const free = await Promise.race([turned.then(() => true, () => true), new Promise<boolean>((done) => setTimeout(() => done(false), 500))]);
        if (free) return failed(new StepFailure(`what the code awaited hadn't settled after ${timeout}ms; it may still settle in the app`));
        await Promise.race([send("Runtime.terminateExecution").catch(() => {}), new Promise((done) => setTimeout(done, 1000))]);
        failed(new StepFailure(`the code kept the main process busy past ${timeout}ms, and was stopped`));
      }, timeout + 250);
    });
    try {
      // The debugger stops code that keeps the main process busy past the
      // timeout; while it is busy, the app's windows can't respond.
      const reply = await Promise.race([
        send("Runtime.evaluate", { expression: wrapped(code, session), includeCommandLineAPI: true, replMode: true, awaitPromise: true, objectGroup: GROUP, timeout }),
        late,
      ]);
      if (reply.error !== undefined) {
        if (Date.now() - begun >= timeout) throw new StepFailure(`the code kept the main process busy for ${timeout}ms, and was stopped`);
        throw new StepFailure(reply.error.message);
      }
      const { result, exceptionDetails } = reply.result as { result: Remote; exceptionDetails?: { text: string; exception?: Remote } };
      if (exceptionDetails !== undefined) throw await failure(exceptionDetails.exception, exceptionDetails.text);
      return await asData(result);
    } finally {
      clearTimeout(timer);
      void send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {});
    }
  }

  try {
    // Electron's own main process, rather than some other Node program: one whose electron module has an app.
    const reply = await send("Runtime.evaluate", { expression: `typeof require("electron").app === "object" ? process.pid : null`, includeCommandLineAPI: true, returnByValue: true });
    const pid = reply.result?.result?.value;
    if (typeof pid !== "number") throw new SetupError(`${inspect} is a Node process, but not an Electron app's main process`);
    // Told when the app is about to exit, so it isn't kept waiting for weblab to let go.
    await send("NodeRuntime.notifyWhenWaitingForDisconnect", { enabled: true });
    await send("Runtime.enable");
    return {
      pid,
      evaluate,
      async close() {
        await Promise.race([send("Runtime.evaluate", { expression: unstub(session), returnByValue: true }).catch(() => {}), new Promise((done) => setTimeout(done, 2000))]);
        gone = "the session has ended";
        socket.close();
      },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

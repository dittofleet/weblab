// An Electron app's main process, joined over the Node debugger it was
// started with (`--inspect=9229`): what the `electron` step runs code in.
//
// Its windows are joined over Chromium's own port (`attach`); the main
// process, which owns the windows, menus, dialogs and IPC, has a port of
// its own and speaks the same protocol's Runtime domain. Nothing is
// opened that the app wasn't started with: weblab never turns the
// debugger on itself.
import { setTimeout as sleep } from "node:timers/promises";
import { endpoint } from "./browser.ts";
import { briefError, SetupError, StepFailure, UsageError } from "./errors.ts";
import { fillFormat } from "./recorder.ts";

/** The main process of the app a session is attached to. */
export type MainProcess = {
  /** Its process id: the same as the browser process of the app's windows. */
  readonly pid: number;
  /** Runs code in it, with `electron` and its modules in scope: its value as data, and whether it was truthy there. */
  evaluate(code: string, timeout: number): Promise<{ value: unknown; truthy: boolean }>;
  /** Puts back what the session's code stubbed, and lets go of it. The app keeps running. */
  close(): Promise<void>;
};

// What code is handed by name, beside `electron` itself and `require`.
const MODULES = ["app", "BrowserWindow", "webContents", "ipcMain", "dialog", "Menu", "shell", "session", "clipboard", "nativeTheme", "screen"];

// Run in the app for one session: its `stub(object, name, replacement)`,
// and what puts back all it stubbed. Each stubbed property keeps how it
// was (its own property, or none, when it came from a prototype) and a
// layer per stub over it, whichever session made it, so sessions that
// stub the same thing can end in any order: the property shows the
// newest layer left, else is as it was. One that something else has
// replaced since is left as that has it. It all lives in one property
// of the app's global, under a symbol of weblab's, gone once nothing is
// stubbed.
const STUBS_FOR = `(session) => {
  const key = Symbol.for("weblab.stubs");
  const stub = (object, name, replacement) => {
    const own = Object.getOwnPropertyDescriptor(object, name);
    try {
      object[name] = replacement;
    } catch {}
    if (object[name] !== replacement) throw new TypeError("stub: " + String(name) + " can't be replaced on this object; it is read-only, or a getter");
    const { slots, sessions } = (globalThis[key] ??= { slots: new WeakMap(), sessions: {} });
    let props = slots.get(object);
    if (props === undefined) slots.set(object, (props = new Map()));
    if (!props.has(name)) props.set(name, { own, layers: [] });
    props.get(name).layers.push({ session, replacement });
    (sessions[session] ??= []).push([object, name]);
  };
  const unstub = () => {
    const stubs = globalThis[key];
    if (stubs === undefined) return;
    for (const [object, name] of (stubs.sessions[session] ?? []).reverse()) {
      const props = stubs.slots.get(object);
      const slot = props?.get(name);
      if (slot === undefined) continue;
      const at = slot.layers.findLastIndex((layer) => layer.session === session);
      if (at === -1) continue;
      const [layer] = slot.layers.splice(at, 1);
      const shown = at === slot.layers.length && object[name] === layer.replacement;
      try {
        if (shown && slot.layers.length > 0) object[name] = slot.layers[slot.layers.length - 1].replacement;
        else if (shown && slot.own === undefined) delete object[name];
        else if (shown) Object.defineProperty(object, name, slot.own);
      } catch {}
      if (slot.layers.length === 0) props.delete(name);
      if (props.size === 0) stubs.slots.delete(object);
    }
    delete stubs.sessions[session];
    if (Object.keys(stubs.sessions).length === 0) delete globalThis[key];
  };
  return { stub, unstub };
}`;

const stubsFor = (session: string) => `(${STUBS_FOR})(${JSON.stringify(session)})`;

// The code goes in a block of its own, inside the one that hands it its
// names, so what it declares with const, let and class stays in it and
// may reuse those names. A block's value is its last statement's, so
// `const n = app.getName(); n` hands back the name.
const wrapped = (code: string, session: string) =>
  `{ const electron = require("electron"); const { ${MODULES.join(", ")} } = electron; const { stub } = ${stubsFor(session)}; { ${code}\n} }`;

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

// What reads as itself, not as its properties: an error (with its stack), a date, a pattern.
const SELF_DESCRIBED = ["error", "date", "regexp"];

// A logged object much as Node's console prints it, from the debugger's
// preview of it, which goes one level deep.
function previewText(preview: Preview): string {
  const more = preview.overflow ? ", ..." : "";
  if (preview.entries !== undefined) {
    const entries = preview.entries.map(({ key, value }) => (key === undefined ? previewText(value) : `${previewText(key)} => ${previewText(value)}`));
    return `${preview.description} { ${entries.join(", ")}${more} }`;
  }
  if (preview.type !== "object" || preview.subtype === "null" || SELF_DESCRIBED.includes(preview.subtype ?? "")) return preview.description ?? "";
  const values = preview.properties.map((property) => {
    const value = property.valuePreview !== undefined ? previewText(property.valuePreview) : property.type === "string" ? `'${property.value}'` : (property.value ?? "");
    return preview.subtype === "array" ? value : `${property.name}: ${value}`;
  });
  if (preview.subtype === "array") return values.length === 0 ? "[]" : `[ ${values.join(", ")}${more} ]`;
  const kind = preview.description === "Object" ? "" : `${preview.description} `;
  return values.length === 0 && more === "" ? `${kind}{}` : `${kind}{ ${values.join(", ")}${more} }`;
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

// One argument as a format's `%d`, `%i` or `%f` reads it, as Node's console does; a BigInt stays one.
function formatArg(arg: Remote, kind: string): string {
  if (!"dif".includes(kind)) return argText(arg);
  if (arg.type === "bigint" && kind !== "f") return arg.unserializableValue ?? "";
  const raw = String(arg.unserializableValue ?? arg.value);
  return String(kind === "d" ? Number(raw) : kind === "i" ? Number.parseInt(raw, 10) : Number.parseFloat(raw));
}

// A console call as it reads.
function consoleText(args: Remote[]): string {
  const [first, ...rest] = args;
  if (first?.type !== "string" || !String(first.value).includes("%")) return args.map(argText).join(" ");
  return fillFormat(String(first.value), rest, formatArg);
}

// Whether a value was truthy where it was, before it is made data: NaN, -0 and 0n are falsy, any object isn't.
const truthy = (remote: Remote): boolean => {
  if (remote.type === "undefined" || remote.subtype === "null") return false;
  if (remote.unserializableValue !== undefined) return !["NaN", "-0", "0n"].includes(remote.unserializableValue);
  return remote.objectId !== undefined || Boolean(remote.value);
};

// How long joining the main process may take.
const JOIN_TIMEOUT = 10_000;

// Work that has to be done in time, or fails with what `late` says.
function within<T>(work: Promise<T>, ms: number, late: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, failed) => {
    timer = setTimeout(() => failed(late()), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

// An error as the step reports it: its own frames, without the ones of the code weblab wrapped.
const errorText = (description: string) => description.split("\n").filter((line) => !/^\s+at .*<anonymous>/.test(line)).join("\n");

/**
 * Joins the main process at `inspect` and checks that it is Electron's.
 * What it logs from now on goes to `log`. `session` names what the code stubs.
 */
export async function joinMainProcess(inspect: string, session: string, log: (type: string, text: string) => void): Promise<MainProcess> {
  // An app paused in a debugger, or busy, doesn't answer: said, rather than waited on for ever.
  const unanswered = () => new SetupError(`the main process at ${inspect} didn't answer within ${JOIN_TIMEOUT / 1000}s; is it paused in a debugger, or busy?`);
  const socket = new WebSocket(await socketAddress(inspect));
  await within(
    new Promise<void>((done, failed) => {
      socket.onopen = () => done();
      socket.onerror = () => failed(new SetupError(`could not join the main process at ${inspect}`));
    }),
    JOIN_TIMEOUT,
    unanswered,
  );
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
    for (const one of waiting.values()) one.failed(new StepFailure(gone));
    waiting.clear();
  };

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Message>((done, failed) => {
      if (gone !== null) return failed(new StepFailure(gone));
      const id = (next += 1);
      waiting.set(id, { done, failed });
      socket.send(JSON.stringify({ id, method, params }));
    });

  // Each evaluation keeps the objects it made in a group of its own, let
  // go of when it is done, so evaluations side by side keep theirs.
  let groups = 0;

  // What the code handed back, or threw, as data.
  async function asData(remote: Remote): Promise<unknown> {
    if (remote.type === "undefined") return undefined;
    if (remote.unserializableValue !== undefined) return remote.unserializableValue;
    if (remote.objectId === undefined) return remote.value;
    const copied = await send("Runtime.callFunctionOn", { objectId: remote.objectId, functionDeclaration: AS_DATA, returnByValue: true });
    return copied.result?.result?.value ?? remote.description;
  }

  // Code that doesn't compile is the author's mistake, told about the
  // code as written, not the block it is put in. A script can't await,
  // which a step can, so code that awaits is read as an async function's
  // body; what reads well that way but not in a block (a return) is told
  // as the block found it.
  async function mistake(code: string, found: Remote): Promise<UsageError> {
    const read = await send("Runtime.compileScript", { expression: /\bawait\b/.test(code) ? `(async () => {\n${code}\n})` : code, sourceURL: "", persistScript: false });
    const description = errorText((read.result?.exceptionDetails?.exception as Remote | undefined)?.description ?? found.description ?? "");
    const hint = /Illegal return/.test(description) ? " (an electron step hands back its last statement's value; it needs no return)" : "";
    return new UsageError(`electron: ${description}${hint}`);
  }

  async function failure(code: string, exception: Remote | undefined, text: string): Promise<Error> {
    if (exception === undefined) return new StepFailure(text);
    // One the code didn't compile with has no frames; one it threw as it ran (JSON.parse's) has.
    if (exception.className === "SyntaxError" && !/\n\s+at /.test(exception.description ?? "")) return mistake(code, exception);
    if (exception.subtype === "error") return new StepFailure(errorText(exception.description ?? text));
    return new StepFailure(`threw ${JSON.stringify(await asData(exception).catch(() => exception.description))}`);
  }

  async function evaluate(code: string, timeout: number): Promise<{ value: unknown; truthy: boolean }> {
    const group = `weblab-${(groups += 1)}`;
    const begun = Date.now();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Objects it handed back or threw are held in the app until let go of.
    let held = false;
    // The code's value, awaited when it is a promise, as a function's would be.
    const run = async (): Promise<Message> => {
      const reply = await send("Runtime.evaluate", { expression: wrapped(code, session), includeCommandLineAPI: true, replMode: true, awaitPromise: true, objectGroup: group, timeout });
      const result = reply.result?.result as Remote | undefined;
      if (reply.result?.exceptionDetails !== undefined || result?.subtype !== "promise") return reply;
      return send("Runtime.awaitPromise", { promiseObjectId: result.objectId });
    };
    // Past the timeout, code is either busy (a loop after an await, which
    // the debugger's own timeout doesn't cover) or waiting. Busy code keeps
    // the event loop from turning, and is stopped; code that waits is left.
    // Never stopped on a guess: a stop when the step's code isn't what is
    // busy lands on the app's own next task, so the loop has to stay
    // stuck a full second, with the code still running.
    const late = new Promise<never>((_, failed) => {
      timer = setTimeout(async () => {
        const turned = send("Runtime.evaluate", { expression: "new Promise((done) => setImmediate(() => done(true)))", awaitPromise: true, returnByValue: true });
        const free = await Promise.race([turned.then(() => true, () => true), sleep(1000, false)]);
        if (settled) return;
        if (free) return failed(new StepFailure(`what the code awaited hadn't settled after ${timeout}ms; it may still settle in the app`));
        await Promise.race([send("Runtime.terminateExecution").catch(() => {}), sleep(1000)]);
        failed(new StepFailure(`the code kept the main process busy past ${timeout}ms, and was stopped`));
      }, timeout + 250);
    });
    try {
      // The debugger stops code that keeps the main process busy past the
      // timeout; while it is busy, the app's windows can't respond.
      const reply = await Promise.race([run().finally(() => (settled = true)), late]);
      if (reply.error !== undefined) {
        if (Date.now() - begun >= timeout) throw new StepFailure(`the code kept the main process busy for ${timeout}ms, and was stopped`);
        throw new StepFailure(reply.error.message);
      }
      const { result, exceptionDetails } = reply.result as { result: Remote; exceptionDetails?: { text: string; exception?: Remote } };
      held = result.objectId !== undefined || exceptionDetails?.exception?.objectId !== undefined;
      if (exceptionDetails !== undefined) throw await failure(code, exceptionDetails.exception, exceptionDetails.text);
      return { value: await asData(result), truthy: truthy(result) };
    } finally {
      clearTimeout(timer);
      if (held) void send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
  }

  try {
    const pid = await within(
      (async () => {
        // Electron's own main process, rather than some other Node program: one whose electron module has an app.
        const reply = await send("Runtime.evaluate", { expression: `typeof require("electron").app === "object" ? process.pid : null`, includeCommandLineAPI: true, returnByValue: true });
        const found = reply.result?.result?.value;
        if (typeof found !== "number") throw new SetupError(`${inspect} is a Node process, but not an Electron app's main process`);
        // Told when the app is about to exit, so it isn't kept waiting for weblab to let go.
        await send("NodeRuntime.notifyWhenWaitingForDisconnect", { enabled: true });
        await send("Runtime.enable");
        return found;
      })(),
      JOIN_TIMEOUT,
      unanswered,
    );
    return {
      pid,
      evaluate,
      async close() {
        await Promise.race([send("Runtime.evaluate", { expression: `${stubsFor(session)}.unstub()`, returnByValue: true }).catch(() => {}), sleep(2000)]);
        gone = "the session has ended";
        socket.close();
      },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

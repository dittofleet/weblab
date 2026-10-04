// The MCP server: the tools over the sessions this process holds.
//
//   new    open a session
//   run    run steps on a session
//   end    end a session, or all of them
//   list   the sessions that are open
//   docs   the reference pages
//
// A reply is text an agent reads as it is, with the screenshots the
// steps took as images.
import { readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCS, docContents, docIndex, docSection, docText, docUri } from "./docs.ts";
import { checkTimeout, fileSteps, inlineSteps } from "./script.ts";
import { end, endAll, endedLines, firstPath, has, MAIN, names, newJob, open, runStep, session, within, type Ended, type Job, type Session } from "./sessions.ts";
import { builtinActions, STEP_NAMES_BY_GROUP } from "./steps/index.ts";
import { mapText } from "./sources.ts";
import type { SessionOptions, Step, StepResult } from "./types.ts";
import { updateNote } from "./update.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

// How long a call waits before it answers with steps still running.
// Under the minute some clients give a tool call.
const DEFAULT_WAIT_MS = Number(process.env.WEBLAB_WAIT_MS) || 45_000;
// How much of a step's value a reply prints.
const MAX_VALUE = 8000;
const MAX_CONSOLE_LINES = 40;
// Pictures past these are named by their path only.
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 2 ** 20;

function printable(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return `(a ${typeof value} that cannot be printed as JSON)`;
  }
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}... (${text.length - MAX_VALUE} more characters)` : text;
}

// The same line many times over, as one line with a count.
function collapse(lines: string[]): string[] {
  const out: [string, number][] = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last !== undefined && last[0] === line) last[1] += 1;
    else out.push([line, 1]);
  }
  return out.map(([line, count]) => (count === 1 ? line : `${line} (x${count})`));
}

// ---- what a job has left to say

/** A job under way, and how much of it replies have told already. */
type Running = {
  job: Job;
  done: Promise<void>;
  finished: boolean;
  startedAt: number;
  told: { steps: number; shots: number; files: number; lines: number };
};

// Steps on one session run one job after another, in the order asked.
const tails = new Map<string, Promise<void>>();
// Jobs a reply left running, oldest first: the next call on their session tells the rest.
const leftRunning = new Map<string, Running[]>();

// `queued` puts it after whatever is running on its session; opening a
// session waits for nothing.
function start(job: Job, work: () => Promise<void>, queued = true): Running {
  const before = (queued ? tails.get(job.on) : undefined) ?? Promise.resolve();
  const running: Running = { job, done: Promise.resolve(), finished: false, startedAt: Date.now(), told: { steps: 0, shots: 0, files: 0, lines: 0 } };
  running.done = before
    .then(() => {
      running.startedAt = Date.now();
      return within(job, work);
    })
    .catch((error) => {
      // What no step accounts for: said, so the reply isn't silent about it.
      job.lines.push(`weblab: ${error instanceof Error ? error.message : String(error)}`);
    })
    .then(() => {
      running.finished = true;
    });
  if (queued) tails.set(job.on, running.done);
  return running;
}

/** Waits for a job, up to a time. True when it finished. */
const settled = (running: Running, ms: number): Promise<boolean> =>
  Promise.race([running.done.then(() => true), sleep(Math.max(ms, 0), false, { ref: false })]);

// A line that stands for a picture: where it is in the lines is where its image goes in the reply.
const IMAGE = "\u0000image:";
const picture = (path: string) => [`shot  ${path}`, `${IMAGE}${path}`];
const indented = (lines: string[]) => lines.map((line) => (line.startsWith(IMAGE) ? line : `  ${line}`));

// A step's outcome, and under it the steps its code ran, numbered within it: 2.1, 2.2.
function stepLines(step: StepResult, prefix = ""): string[] {
  const lines: string[] = [];
  const number = `${prefix}${step.index}`;
  const from = step.from === undefined ? "" : ` (${step.from})`;
  const on = step.on === undefined ? "" : ` on ${step.on}`;
  // A step written wrong already names itself in what it says.
  const error = step.error?.startsWith(`${step.action}: `) ? step.error.slice(step.action.length + 2) : step.error;
  if (step.status === "passed") lines.push(`ok    ${number} ${step.action}${on}${from} (${step.ms}ms)`);
  else lines.push(`FAIL  ${number} ${step.action}${on}${from}: ${error}`);
  for (const text of step.notes ?? []) lines.push(`note  ${text}`);
  for (const inner of step.steps ?? []) lines.push(...indented(stepLines(inner, `${number}.`)));
  if (step.value !== undefined) {
    // What a step reads out (a look, a react step) is printed as it is, and anything else as JSON.
    if (builtinActions[step.action]?.prints && typeof step.value === "string") lines.push("", step.value, "");
    else lines.push(printable(step.value));
  }
  // Each picture under the step that took it.
  for (const path of [...(step.shots ?? []), ...(step.screenshot === undefined ? [] : [step.screenshot])]) lines.push(...picture(path));
  return lines;
}

/** What a job has done since the last reply about it, pictures in their places. */
function news(running: Running): string[] {
  const { job, told } = running;
  // A step still under way is told once it is done.
  const whole = running.finished ? job.steps.length : Math.max(job.steps.length - 1, told.steps);
  const steps = job.steps.slice(told.steps, whole);
  const shots = job.shots.slice(told.shots);
  const files = job.files.slice(told.files);
  const lines = [...job.lines.slice(told.lines), ...steps.flatMap((step) => stepLines(step)), ...shots.flatMap(picture), ...files.map((path) => `file  ${path}`)];
  running.told = { steps: whole, shots: job.shots.length, files: job.files.length, lines: job.lines.length };
  return lines;
}

// Where a session is now, and what it logged since the last reply.
// `always` says where even when that hasn't changed.
async function where(name: string, always: boolean): Promise<string[]> {
  // The steps may have ended the session they were on.
  if (!has(name)) return [];
  const open = session(name);
  const { ctx } = open;
  const lines: string[] = [];
  const url = ctx.page.url();
  const title = await ctx.page.title().catch(() => "");
  if (always || `${url}\n${title}` !== open.shown) {
    lines.push(`url   ${url}`);
    if (title !== "") lines.push(`title ${title}`);
  }
  open.shown = `${url}\n${title}`;
  // The tabs, when there's more than one and they've changed since the last reply.
  const tabs = ctx.context.pages().map((tab, index) => `tab ${index}${tab === ctx.page ? "*" : " "} ${tab.url()}`);
  if (tabs.length > 1 && (always || tabs.join("\n") !== open.shownTabs)) lines.push(...tabs);
  open.shownTabs = tabs.join("\n");
  const all = collapse(open.consoleSinceLast().filter((line) => !line.startsWith("--- ") && !line.startsWith("[weblab]")));
  if (all.length > 0) {
    // Stacks in the lines shown point at the source, as the project names it, not at what was served.
    const shown = await Promise.all(all.slice(-MAX_CONSOLE_LINES).map((line) => mapText(line, (place) => ctx.sources.known(place))));
    lines.push("", `console since the last reply${all.length > shown.length ? ` (the last ${shown.length} of ${all.length} lines; all of it is in ${open.consoleLog})` : ""}:`, ...shown.map((line) => `  ${line}`));
  }
  return lines;
}

// Text, with each picture as an image right after the line that names it.
// An error is a call that couldn't be done, a step that never ran
// included. A step that ran and failed is a result: its picture is what
// the reader needs, and some clients show an error's text alone.
function result(lines: string[], isError = false): Result {
  const content: Content[] = [];
  let text: string[] = [];
  let images = 0;
  const flush = () => {
    const block = text.join("\n").trim();
    if (block !== "") content.push({ type: "text", text: block });
    text = [];
  };
  for (const line of lines) {
    if (!line.startsWith(IMAGE)) {
      text.push(line);
      continue;
    }
    const path = line.slice(IMAGE.length);
    try {
      // Past these its path, in the text, is how it is found.
      if (images >= MAX_IMAGES || statSync(path).size > MAX_IMAGE_BYTES) continue;
      const data = readFileSync(path).toString("base64");
      flush();
      content.push({ type: "image", data, mimeType: "image/png" });
      images += 1;
    } catch {
      // Gone, or never written: its path is in the text all the same.
    }
  }
  flush();
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  return { content, ...(isError ? { isError } : {}) };
}

// Whatever a tool does, the caller gets an answer it can act on.
async function answering(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    return result([`weblab: ${error instanceof Error ? error.message : String(error)}`], true);
  }
}

const describe = (open: Session): string => {
  const { attach, mainProcess } = open.app.settings;
  const where = open.attached ? [`attached to ${attach}`, mainProcess !== undefined && `main process at ${mainProcess}`, open.address !== null && `at ${open.address}`] : [`at ${open.address}`];
  const at = where.filter(Boolean).join(", ") + (open.gone() ? "  (gone: the app quit or restarted)" : "");
  const server = open.server?.owned ? ` (server started by weblab: ${open.server.command})` : "";
  return `${open.name}  ${at}${server}`;
};

// ---- the tools

// Whether this weblab has said a newer release is out.
let noted = false;

const viewport = z.union([
  z.string().describe(`"1440x900", or "390x844@3" with a pixel scale`),
  z.object({ width: z.number().optional(), height: z.number().optional(), deviceScaleFactor: z.number().optional() }),
]);

const sessionOptions = z.object({
  name: z.string().optional().describe(`What to call it: what run, end and a step's "on" say. Default: "main", then session2, session3, ...`),
  address: z.union([z.string(), z.number()]).optional().describe("Where the app answers: a URL (a path on it is where the session goes first), host:port, or a port. Default: the project's dev server (the PORT in its .env, else wherever its dev script says it is listening). Whatever already answers at the address is used as it is."),
  start: z.string().optional().describe("The command that starts the app, run in the project's root (the nearest package.json at or above dir) when nothing answers at the address. It gets the address's port as PORT. Default: the project's dev script. A server weblab starts is shared by every session at its address and stopped when the last of them ends."),
  startTimeout: z.number().optional().describe("How long a server weblab starts gets to answer, in milliseconds (default: 60000)."),
  dir: z.string().optional().describe("The project directory: where its dev script and .env are, and where relative paths in steps are read from. Default: where weblab was started."),
  path: z.string().optional().describe(`Where to go first: a path or URL. Default: "/", or with attach, wherever the browser already is.`),
  attach: z.union([z.string(), z.number()]).optional().describe("Join a browser or Electron app that is already running, by its remote debugging port or address, instead of launching one. It is left as it was found."),
  tab: z.string().optional().describe("With attach: which tab to drive, by part of its URL or title (default: the first)."),
  newTab: z.boolean().optional().describe("With attach: drive a new tab, and leave the browser's own alone."),
  mainProcess: z.union([z.string(), z.number()]).optional().describe("With attach to an Electron app: its main process's Node debugger port or address (from --inspect=<port>), for electron steps."),
  browser: z.string().optional().describe("The browser to launch: chrome (default), edge, brave, chromium, another installed Chromium browser's name or path; or webkit (Safari's engine) or firefox, which are Playwright's own builds."),
  browserArgs: z.array(z.string()).optional().describe("Extra command-line flags for the browser it launches."),
  headed: z.boolean().optional().describe("Give the browser a window on the screen (default: headless)."),
  persist: z.boolean().optional().describe("Keep one browser profile for this project between sessions, for what an app caches in the browser. One session at a time can use it."),
  state: z.string().optional().describe("Start signed in: the name a saveState step saved cookies and storage under."),
  viewport: viewport.optional().describe("The page's size (default: 1440x900 at 2x)."),
  context: z.record(z.string(), z.unknown()).optional().describe(`Playwright browser context options, as given: { "colorScheme": "dark", "locale": "de-DE", "isMobile": true, "permissions": [...], ... }`),
  trace: z.union([z.boolean(), z.literal("on-failure")]).optional().describe(`Keep a Playwright trace, written when the session ends: true, or "on-failure" to keep it only if a step failed.`),
  timeout: z.number().optional().describe("How long each step may take, in milliseconds, unless the run or the step says (default: 10000)."),
  ignore: z.array(z.string()).optional().describe("Console output and failed requests matching these regular expressions are left out of the console log and of error checks."),
  init: z.union([z.string(), z.array(z.string())]).optional().describe("A script file, or several, run in every page before its own scripts: a stub for what the page expects to find (an Electron app's preload API)."),
  ready: z
    .object({ selector: z.string().optional(), text: z.string().optional(), js: z.string().optional(), timeout: z.number().optional() })
    .optional()
    .describe("What goto, ready and video wait for: an element, some text, or a JavaScript expression that turns true (default: #root or #app has children, or the page has loaded)."),
  out: z.string().optional().describe("The directory its screenshots, logs and videos go to (default: one under the system's temp directory, shared by this weblab's sessions)."),
  // Kept, rather than dropped, so an option new doesn't take is refused by name.
}).loose();

const step = z.record(z.string(), z.unknown());

// Each step's name, by group: what each takes is one docs call away.
const STEPS = STEP_NAMES_BY_GROUP.map(([title, names]) => `${title}: ${names.join(", ")}`).join("\n");

// Claude Code cuts a tool's description at 2048 characters, so what an
// agent needs first comes first, and the details are left to docs.
const RUN = `Run steps on a session, in order, stopping at the first that fails. The session stays open either way.

A step is an object with one action: { "click": "text=Save" }, { "shot": { "as": "home", "fullPage": true } }, { "back": true }. Beside its action a step may have "on" (another session's name), "timeout" (ms), "message" (what to say if it fails), "note" (a comment).

Where a step takes an element, it takes any of: a Playwright selector ("button.save", "text=Sign in"), a ref a look step printed ("e12"), or an object: { "role": "button", "name": "Save" }, { "label": "Email" }, { "placeholder": ... }, { "text": ... }, { "testId": ... }, { "altText": ... }, { "title": ... }, { "component": "CartItem" } (React), with optional nth, exact, frame, within. In an object step the element's keys sit beside the step's own: { "fill": { "label": "Email", "value": "ada@example.com" } }.

The steps, by group. For one step's forms and options, call docs with its name as the section: { "section": "expect" }.
${STEPS}

The reply has each step's outcome, what it handed back (a look's text, a js or playwright step's value), each screenshot as an image right after the step that took it, where the page is when that changed, and what the console logged since the last reply. Steps that code ran are listed under its step, with what they handed back.

A run that takes longer than the call waits is left running: the reply says which step it is on, and the next run on that session tells the rest. Steps given meanwhile are queued after it.`;

const INSTRUCTIONS = `weblab drives real browsers for testing and exploring web apps.

A session is a browser of its own (its cookies, its tabs) pointing at an address, with a name. Open one with new, run steps on it with run, end it with end. Any number can be open at once: two users are two sessions, and so are two copies of an app on two ports, or two windows of a running Electron app (attach).

Only addresses can conflict. Whatever answers at a session's address is used as it is; if nothing does, weblab starts the project's dev script (or the start command given) there, shares that server among the sessions pointing at it, and stops it when the last of them ends.

The docs tool has the full reference (also offered as resources, weblab://docs/<page>): every argument, every step's options, and recipes for common tasks. It reads a whole page, or one section: { "section": "shot" } is one step's forms and options.

To see a page, run { "look": true } (its accessibility tree, with refs to act on) or { "shot": "name" } (a screenshot). In a React app, { "react": "tree" } shows its components and { "react": { "inspect": ... } } one of them, with its file and line. To do anything the built-in steps don't, run a js, playwright or cdp step; an electron step runs code in an attached Electron app's main process (new's mainProcess). Sessions end when this weblab exits; nothing is written into the project.`;

export function createServer(version: string): McpServer {
  const server = new McpServer({ name: "weblab", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "new",
    {
      title: "New session",
      description:
        "Open a session: a browser of its own pointing at an address, with a name. With no arguments: a session named main at the project's dev server, started if it isn't running. The reply says where it is and shows what the first page logged.",
      inputSchema: sessionOptions,
    },
    (options) =>
      answering(async () => {
        const job = newJob("");
        const running = start(job, async () => {
          const opened = await open(options as SessionOptions);
          job.on = opened.name;
          const path = firstPath(opened, options.path);
          if (path !== undefined) await runStep(job, { goto: path });
        }, false);
        // Opening is one thing to wait for: a server may take its minute to start.
        await running.done;
        const lines = news(running);
        if (!has(job.on)) return result(lines, true);
        const opened = session(job.on);
        // A newer release is said once, where a session starts.
        const note = noted ? null : updateNote();
        noted ||= note !== null;
        return result([`session ${describe(opened)}`, `files ${opened.dir}`, ...lines, ...(await where(job.on, true)), ...(note === null ? [] : ["", note])], job.steps.some((step) => step.refused));
      }),
  );

  server.registerTool(
    "run",
    {
      title: "Run steps",
      description: RUN,
      inputSchema: z.object({
        session: z.string().optional().describe(`The session the steps are for (default: "main"). A step says another with "on".`),
        steps: z.union([z.array(step), step]).optional().describe("The steps, or one step. Give steps or file."),
        file: z.string().optional().describe("A file of steps to run in place of steps: a JSON list of steps, or a .ts/.js file whose default export is async ({ page, context, step, newSession, locate, params }) => { ... }, where page is Playwright's and step runs any step here."),
        params: z.record(z.string(), z.unknown()).optional().describe("Values for ${name} placeholders in the steps or the file, and handed to code as params."),
        timeout: z.number().optional().describe("How long each step may take, in milliseconds, unless the step says (default: the session's)."),
        wait: z.number().optional().describe(`How long this call waits before it replies with the steps still running, in milliseconds (default: ${DEFAULT_WAIT_MS}).`),
      }).strict(),
    },
    ({ session: on = MAIN, steps, file, params, timeout, wait }) =>
      answering(async () => {
        // What was given is read before anything else, so a mistake in it costs nothing that was running.
        if (steps !== undefined && file !== undefined) return result(["run: give steps or file, not both"], true);
        checkTimeout(timeout, "run");
        checkTimeout(wait, "run: wait");
        const base = has(on) ? session(on).app.root : process.cwd();
        const given: Step[] | null = file !== undefined ? fileSteps(file, base, params) : steps !== undefined ? inlineSteps(steps, base, params) : null;

        const deadline = Date.now() + (wait ?? DEFAULT_WAIT_MS);
        const lines: string[] = [];
        let refused = false;
        const tell = (running: Running) => {
          lines.push(...news(running));
          refused ||= running.job.steps.some((step) => step.refused);
        };
        const stillRunning = (running: Running) => {
          const now = running.job.steps.at(-1);
          lines.push(`still running${now === undefined ? "" : `: step ${now.index} (${now.action})`}, ${Math.round((Date.now() - running.startedAt) / 1000)}s in. Call run on "${on}" again, with no steps, to wait for the rest.`);
        };

        // What earlier replies left running is told first, oldest first.
        const left = leftRunning.get(on) ?? [];
        leftRunning.set(on, left);
        const hadLeft = left.length > 0;
        let waitingOn: Running | undefined;
        for (let first = left[0]; first !== undefined; first = left[0]) {
          const finished = await settled(first, deadline - Date.now());
          tell(first);
          if (!finished) {
            waitingOn = first;
            break;
          }
          // Another call may have told it and moved on already.
          if (left[0] === first) left.shift();
        }

        if (given === null) {
          if (!hadLeft) return result([`run: nothing to run on "${on}": give steps or file`], true);
          if (waitingOn !== undefined) stillRunning(waitingOn);
          return result([...lines, ...(waitingOn === undefined ? await where(on, false) : [])], refused);
        }

        const job = newJob(on, { params, timeout });
        const running = start(job, async () => {
          for (const one of given) {
            if (!(await runStep(job, one)).ok) break;
          }
        });
        if (waitingOn !== undefined) {
          left.push(running);
          stillRunning(waitingOn);
          lines.push("The steps given now are queued after it.");
          return result(lines, refused);
        }
        const finished = await settled(running, deadline - Date.now());
        tell(running);
        if (!finished) {
          left.push(running);
          stillRunning(running);
          return result(lines, refused);
        }
        return result([...lines, ...(await where(on, false))], refused);
      }),
  );

  server.registerTool(
    "end",
    {
      title: "End session",
      description:
        "End a session: its browser closes, a video still being recorded and its trace are written, and a server weblab started for it stops if no other session is using it. With no session named, ends every session.",
      inputSchema: z.object({ session: z.string().optional().describe("The session to end (default: all of them).") }).strict(),
    },
    ({ session: name }) =>
      answering(async () => {
        if (name === undefined && names().length === 0) return result(["no session is open"]);
        const dirs = new Set((name === undefined ? names() : [name]).filter(has).map((one) => session(one).dir));
        // As part of a job, so what ending says (an mp4 that wasn't written) is told too.
        const job = newJob(name ?? "");
        const ended: Ended[] = await within(job, async () => (name === undefined ? endAll() : [await end(name)]));
        for (const one of ended) {
          // Steps still under way on it have nothing left to run on, and nothing waits behind them.
          leftRunning.delete(one.name);
          tails.delete(one.name);
        }
        const left = names();
        // A server the sessions ended here shared is stopped by the last of them: only that is worth saying.
        const said = ended.flatMap(endedLines);
        const told = said.filter((line) => {
          const shared = /^left the server at (\S+) running: another session/.exec(line);
          return shared === null || !said.includes(`stopped the server at ${shared[1]}`);
        });
        return result([...told, ...job.files.map((path) => `file  ${path}`), ...job.lines, ...[...dirs].map((dir) => `files ${dir}`), ...(left.length === 0 ? [] : [`still open: ${left.join(", ")}`])]);
      }),
  );

  server.registerTool(
    "list",
    {
      title: "List sessions",
      description: "The sessions that are open: each one's name, address, where its page is now, and whether steps are running on it.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    () =>
      answering(async () => {
        if (names().length === 0) return result(["no session is open"]);
        const lines: string[] = [];
        for (const name of names()) {
          // One may have ended while the last was being read.
          if (!has(name)) continue;
          const open = session(name);
          const left = leftRunning.get(name) ?? [];
          const running = left.find((one) => !one.finished);
          const now = running?.job.steps.at(-1);
          lines.push(describe(open), `  url   ${open.ctx.page.url()}`);
          const title = await open.ctx.page.title().catch(() => "");
          if (title !== "") lines.push(`  title ${title}`);
          if (now !== undefined) lines.push(`  running step ${now.index} (${now.action})`);
          else if (left.length > 0) lines.push("  a run has finished: call run with no steps for its results");
          lines.push(`  files ${open.dir}`);
        }
        return result(lines);
      }),
  );

  const pages = DOCS.map((page) => page.name) as [string, ...string[]];
  server.registerTool(
    "docs",
    {
      title: "Read the docs",
      description: `weblab's reference pages, whole or a section at a time. With no arguments, lists the pages and their sections. Pages:\n${docIndex()}`,
      inputSchema: z.object({
        page: z.enum(pages).optional().describe("The page to read whole, or with section, the page to look in."),
        section: z.string().optional().describe(`One section: a step's name ("mock", which gives that step's forms and options), or a heading as it is written or as a link's anchor ("Refs", "steps#refs").`),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ page, section }) =>
      answering(async () => {
        if (section !== undefined) return result([docSection(section, page)]);
        const found = DOCS.find((one) => one.name === page);
        return result([found === undefined ? docContents() : docText(found)]);
      }),
  );

  // The same pages, for clients that show a server's resources.
  for (const page of DOCS) {
    server.registerResource(page.name, docUri(page.name), { title: `weblab docs: ${page.name}`, description: page.about, mimeType: "text/markdown" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: docText(page) }],
    }));
  }

  return server;
}

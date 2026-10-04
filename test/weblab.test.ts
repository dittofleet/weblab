// End to end against test/fixture-app: a real weblab process spoken to
// over stdio in the 2026-07-28 MCP format, driving the system Chrome.
// Every weblab here shares one state dir of the tests' own, so nothing
// touches servers weblab is running for real projects.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, test as nodeTest } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

// From source by default; WEBLAB_BIN points the same tests at a compiled binary.
const [bin, ...prefix] = process.env.WEBLAB_BIN ? [resolve(process.env.WEBLAB_BIN)] : ["bun", join(import.meta.dirname, "..", "src", "main.ts")];
const app = join(import.meta.dirname, "fixture-app");
const kit = join(import.meta.dirname, "fixture-kit");
const scratch = mkdtempSync(join(tmpdir(), "weblab-test-"));
const VERSION = "2026-07-28";
// What every session here is opened with.
const BASE = { viewport: "800x600@1", ignore: ["favicon"] };

// These start servers and Chrome, which a busy machine makes slow.
function test(name: string, body: () => void | Promise<void>): void;
function test(name: string, options: { skip?: boolean }, body: () => void | Promise<void>): void;
function test(name: string, ...rest: unknown[]) {
  const body = rest.pop() as () => void | Promise<void>;
  nodeTest(name, { timeout: 90_000, ...(rest[0] as object) }, body);
}

type Reply = { text: string; images: number; isError: boolean; /** Each block of the reply in order: its text, or "image". */ blocks: string[] };
type Weblab = {
  child: ChildProcess;
  rpc(method: string, params?: Record<string, unknown>, meta?: boolean): Promise<any>;
  tool(name: string, args?: Record<string, unknown>): Promise<Reply>;
  /** Closes its stdin, as a client going away does, and waits for it to exit. */
  close(): Promise<void>;
};

const all: Weblab[] = [];
let count = 0;

function weblab(env: Record<string, string> = {}): Weblab {
  const child = spawn(bin as string, prefix, { cwd: app, env: { ...process.env, XDG_STATE_HOME: join(scratch, "state"), WEBLAB_NO_UPDATE_CHECK: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (message: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    // Nothing but the protocol is ever on stdout.
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  let id = 0;
  const meta = {
    "io.modelcontextprotocol/protocolVersion": VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "weblab-tests", version: "0" },
  };
  const rpc = (method: string, params: Record<string, unknown> = {}, modern = true) =>
    new Promise<any>((done) => {
      const mine = (id += 1);
      waiting.set(mine, done);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params: modern ? { ...params, _meta: meta } : params })}\n`);
    });
  const exited = new Promise<void>((done) => child.on("exit", () => done()));
  const made: Weblab = {
    child,
    rpc,
    async tool(name, args = {}) {
      const { result, error } = await rpc("tools/call", { name, arguments: args });
      if (error !== undefined) throw new Error(`${name}: ${JSON.stringify(error)}\n${stderr}`);
      assert.equal(result.resultType, "complete");
      const content = result.content as { type: string; text?: string }[];
      return {
        text: content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
        images: content.filter((block) => block.type === "image").length,
        isError: result.isError === true,
        blocks: content.map((block) => (block.type === "text" ? (block.text as string) : "image")),
      };
    },
    async close() {
      child.stdin!.end();
      await exited;
    },
  };
  all.push(made);
  return made;
}

after(async () => {
  await Promise.all(all.map((one) => one.close()));
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(app, ".env"), { force: true });
});

const answers = async (origin: string) => {
  try {
    await fetch(origin, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
};

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer();
    probe.listen(0, "localhost", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });

const out = () => join(scratch, `out-${(count += 1)}`);
const originIn = (text: string) => /at (http:\/\/localhost:\d+)/.exec(text)?.[1] as string;
const steps = (name: string) => join(kit, "scenarios", `${name}.json`);

test("it speaks the 2026-07-28 format, and still answers a client that opens with initialize", async () => {
  const modern = weblab();
  const { result: discovered } = await modern.rpc("server/discover");
  assert.deepEqual(discovered.supportedVersions, [VERSION]);
  assert.equal(discovered.resultType, "complete");
  assert.equal(discovered._meta["io.modelcontextprotocol/serverInfo"].name, "weblab");
  assert.match(discovered.instructions, /A session is a browser of its own/);

  const { result: listed } = await modern.rpc("tools/list");
  assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name), ["new", "run", "end", "list", "docs"]);
  assert.equal(typeof listed.ttlMs, "number");
  // Every step is in the run tool's description, so nothing else has to be read to use it.
  const run = listed.tools.find((tool: { name: string }) => tool.name === "run");
  for (const step of ["goto", "click", "fill", "expect", "look", "shot", "js", "playwright", "cdp", "mock", "new", "end", "include"]) assert.match(run.description, new RegExp(`^  ${step}: `, "m"));
  assert.deepEqual(Object.keys(run.inputSchema.properties).sort(), ["file", "params", "session", "steps", "timeout", "wait"]);

  // The docs come with it: through a tool, and as resources.
  assert.match((await modern.tool("docs")).text, /^tools: .*\nsteps: .*\nsessions: .*\ncode: .*\nrecipes: /);
  const stepsPage = (await modern.tool("docs", { page: "steps" })).text;
  assert.match(stepsPage, /^# Steps/);
  assert.match(stepsPage, /\]\(weblab:\/\/docs\/\w+(#[\w-]+)?\)/, "links between pages point at the pages as offered here");
  assert.doesNotMatch(stepsPage, /\]\(\w+\.md/);
  const { result: resources } = await modern.rpc("resources/list");
  assert.deepEqual(resources.resources.map((resource: { uri: string }) => resource.uri), ["tools", "steps", "sessions", "code", "recipes"].map((name) => `weblab://docs/${name}`));
  const { result: read } = await modern.rpc("resources/read", { uri: "weblab://docs/recipes" });
  assert.match(read.contents[0].text, /^# Recipes/);

  assert.match((await modern.tool("list")).text, /no session is open/);
  assert.match((await modern.tool("end")).text, /no session is open/);
  await modern.close();

  // A version it doesn't speak is refused by name, with the ones it does.
  const other = weblab();
  const { error } = await other.rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01", "io.modelcontextprotocol/clientCapabilities": {} } }, false);
  assert.equal(error.code, -32022);
  assert.deepEqual(error.data.supported, [VERSION]);
  await other.close();

  const legacy = weblab();
  const { result: hello } = await legacy.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "0" } }, false);
  assert.equal(hello.protocolVersion, "2025-06-18");
  assert.equal(hello.serverInfo.name, "weblab");
  legacy.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const { result: old } = await legacy.rpc("tools/list", {}, false);
  assert.equal(old.tools.length, 5);
  await legacy.close();
});

test("new starts the project's server, run drives the page and shows it, end stops the server", async () => {
  const lab = weblab();
  const dir = out();
  const opened = await lab.tool("new", { ...BASE, out: dir });
  assert.equal(opened.isError, false, opened.text);
  assert.match(opened.text, /^session main {2}at http:\/\/localhost:\d+ \(server started by weblab: bun run dev\)/);
  assert.match(opened.text, /ok {4}1 goto/);
  assert.match(opened.text, /title fixture/);
  assert.match(opened.text, /console since the last reply:\n {2}\[console\.log\] fixture mounted/);
  const origin = originIn(opened.text);
  assert.equal(await answers(origin), true);
  // Only the port is ever taken from the env file.
  assert.ok(!opened.text.includes("do-not-print"));

  const ran = await lab.tool("run", { steps: [{ click: "#inc" }, { js: "document.querySelector('#inc').textContent" }, { look: { selector: "h1" } }, { shot: "home" }] });
  assert.equal(ran.isError, false, ran.text);
  assert.match(ran.text, /ok {4}2 js \(\d+ms\)\n"count 1"/);
  assert.match(ran.text, /- heading "Fixture app" \[level=1\] \[ref=e\d+\]/);
  assert.equal(ran.images, 1, "the screenshot comes back as an image");
  assert.ok(existsSync(join(dir, "shots", "main-home.png")));
  // Nothing moved, so the reply doesn't say again where the page is.
  assert.doesNotMatch(ran.text, /^url /m);

  // Each picture comes right after the step that took it, so several in one reply are told apart.
  const several = await lab.tool("run", { steps: [{ shot: "first" }, { js: "1 + 1" }, { shot: { as: "button", selector: "#inc" } }, { expect: "nowhere", timeout: 200 }] });
  assert.equal(several.blocks.length, 6);
  assert.match(several.blocks[0] as string, /^ok {4}1 shot \(\d+ms\)\nshot {2}.*main-first\.png$/);
  assert.equal(several.blocks[1], "image");
  assert.match(several.blocks[2] as string, /^ok {4}2 js \(\d+ms\)\n2\nok {4}3 shot \(\d+ms\)\nshot {2}.*main-button\.png$/);
  assert.equal(several.blocks[3], "image");
  assert.match(several.blocks[4] as string, /^FAIL {2}4 expect: .*\nshot {2}.*main-FAIL-4-expect\.png$/);
  assert.equal(several.blocks[5], "image");
  // An expression that throws says what it threw.
  assert.match((await lab.tool("run", { steps: [{ expect: { js: "nope.nope" }, timeout: 300 }] })).text, /expected nope\.nope to be truthy, but it threw: .*nope is not defined/);

  // One step alone, and a ref from the look before it.
  const ref = /heading "Fixture app" \[level=1\] \[ref=(e\d+)\]/.exec(ran.text)?.[1];
  assert.equal((await lab.tool("run", { steps: { expect: { ref, text: "Fixture app" } } })).isError, false);
  const moved = await lab.tool("run", { steps: [{ goto: "/other" }] });
  assert.match(moved.text, /url {3}http:\/\/localhost:\d+\/other\ntitle other/);
  const stale = await lab.tool("run", { steps: [{ click: ref }] });
  assert.match(stale.text, /is from a look at .*, and the page has changed since: run a look step/);

  const listed = await lab.tool("list");
  assert.match(listed.text, /^main {2}at http:\/\/localhost:\d+ \(server started by weblab: bun run dev\)\n {2}url {3}http.*\/other/);

  const ended = await lab.tool("end", { session: "main" });
  assert.match(ended.text, new RegExp(`ended main\nstopped the server at ${origin}`));
  assert.equal(await answers(origin), false, "the server weblab started is stopped");
  assert.match(readFileSync(join(dir, "console", "main.log"), "utf8"), /fixture mounted/);
  await lab.close();
});

test("every kind of step and target works from a file, and a saved sign-in carries to a later session", async () => {
  const lab = weblab();
  const dir = out();
  assert.equal((await lab.tool("new", { ...BASE, out: dir })).isError, false);
  const everything = await lab.tool("run", { file: steps("everything") });
  assert.equal(everything.isError, false, everything.text);
  assert.equal(readFileSync(join(dir, "downloads", "note.txt"), "utf8"), "saved file");
  assert.match(readFileSync(join(dir, "looks", "main-page.yml"), "utf8"), /heading "Fixture app"/);
  // The mocked answer is marked as mocked; the real one isn't.
  const network = readFileSync(join(dir, "network", "main.log"), "utf8");
  assert.match(network, /200 GET .*\/api\/me \(mocked\)/);
  assert.match(network, /200 GET .*\/api\/me$/m);
  assert.match(readFileSync(join(dir, "console", "main.log"), "utf8"), /\[dialog confirm\] Sure\? \(dismissed\)/);

  // The state the file saved signs a second session in, and its trace is kept when it ends.
  const signedIn = await lab.tool("new", { ...BASE, name: "ada", state: "ada", trace: true, out: dir });
  assert.equal(signedIn.isError, false, signedIn.text);
  assert.equal((await lab.tool("run", { session: "ada", file: join(kit, "other", "signed-in.json") })).isError, false);
  assert.match((await lab.tool("end", { session: "ada" })).text, /trace .*traces\/ada\.zip/);
  assert.ok(existsSync(join(dir, "traces", "ada.zip")));

  const nobody = await lab.tool("new", { name: "x", state: "nobody" });
  assert.equal(nobody.isError, true);
  assert.match(nobody.text, /no saved state named "nobody"/);

  // A file with steps that include another, an upload beside it, and a context option.
  assert.equal((await lab.tool("new", { ...BASE, name: "dark", context: { colorScheme: "dark" }, out: dir })).isError, false);
  const pass = await lab.tool("run", { session: "dark", file: steps("pass") });
  assert.equal(pass.isError, false, pass.text);
  assert.match(pass.text, /ok {4}\d+ fill \(greet\.json step 1\)/);
  assert.equal(pass.images, 2);
  await lab.close();
});

test("a failed step says why with a picture, stops the run, and leaves the session to go on", async () => {
  const lab = weblab();
  const dir = out();
  await lab.tool("new", { ...BASE, out: dir });
  const failed = await lab.tool("run", { steps: [{ click: "#inc" }, { expect: "not there", timeout: 300, message: "the greeting is missing" }, { click: "#inc" }] });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /ok {4}1 click/);
  assert.match(failed.text, /FAIL {2}2 expect: the greeting is missing \(expected the text "not there" to be visible\)/);
  assert.doesNotMatch(failed.text, /3 click/);
  assert.equal(failed.images, 1);
  assert.ok(existsSync(join(dir, "shots", "main-FAIL-2-expect.png")));
  // The page is as the steps left it.
  assert.match((await lab.tool("run", { steps: [{ js: "document.querySelector('#inc').textContent" }] })).text, /"count 1"/);

  // A click that something else would take names what is in the way.
  const covered = await lab.tool("run", {
    steps: [{ js: "document.body.insertAdjacentHTML('beforeend', '<div id=pill style=\"position:fixed;inset:0\">pill</div>')" }, { click: "#inc", timeout: 1000 }, { js: "document.querySelector('#pill').remove()" }],
  });
  assert.match(covered.text, /FAIL {2}2 click: Timeout 1000ms exceeded waiting for locator\('#inc'\)\.first\(\): <div id="pill">pill<\/div> intercepts pointer events$/m);

  // Steps written wrong say how, and take no picture.
  const typo = await lab.tool("run", { steps: [{ clik: "#inc" }] });
  assert.match(typo.text, /unknown step "clik" \(did you mean "click"\?\)/);
  assert.match((await lab.tool("run", { steps: [{ click: "#inc", fill: "x" }] })).text, /expected exactly one action, found 2 \(click, fill\)/);
  assert.match((await lab.tool("run", { steps: [{ click: { selector: "#inc", buton: "right" } }] })).text, /FAIL {2}1 click: no option "buton" \(did you mean "button"\?\)/);
  assert.match((await lab.tool("run", { steps: [{ viewport: "500x400@2" }] })).text, /viewport: expected a size alone/);
  assert.match((await lab.tool("run", { steps: [{ js: "1" }], timeout: 0 })).text, /run: timeout is a number of milliseconds, not 0/);
  assert.match((await lab.tool("run", { steps: [{ click: "#inc", on: "nobody" }] })).text, /no session "nobody" is open; open: main/);
  assert.match((await lab.tool("run", { session: "mian", steps: [{ click: "#inc" }] })).text, /no session "mian" is open \(did you mean "main"\?\)/);
  assert.match((await lab.tool("run", {})).text, /nothing to run on "main": give steps or file/);
  assert.match((await lab.tool("run", { file: "nowhere.json" })).text, /no such file/);
  assert.match((await lab.tool("new", { ...BASE, name: "main" })).text, /a session named "main" is already open/);
  assert.match((await lab.tool("new", { name: "two", tab: "x" })).text, /tab and newTab say what to drive in a running browser; they need attach/);
  await lab.close();
});

test("two sessions are two users: a step opens the second, and steps say which they are for", async () => {
  const lab = weblab();
  const dir = out();
  await lab.tool("new", { ...BASE, out: dir });
  const ran = await lab.tool("run", {
    steps: [
      { click: "#signin" },
      { expect: { selector: "#signed", text: "signed in as ada" } },
      { new: { name: "guest", path: "/other" } },
      { expect: "Other page", on: "guest" },
      { goto: "/", on: "guest" },
      { expect: { selector: "#signed", text: "signed out" }, on: "guest" },
      { shot: "guest-home", on: "guest" },
      { expect: { selector: "#signed", text: "signed in as ada" } },
    ],
  });
  assert.equal(ran.isError, false, ran.text);
  assert.match(ran.text, /ok {4}4 expect on guest/);
  assert.ok(existsSync(join(dir, "shots", "guest-guest-home.png")));
  // It took after the session the step was on: the same address, the same size.
  assert.match((await lab.tool("run", { session: "guest", steps: [{ js: "[innerWidth, location.origin === '" + originIn((await lab.tool("list")).text) + "']" }] })).text, /800,\s+true/);
  assert.match((await lab.tool("list")).text, /^main .*\n(.*\n)*guest /m);

  // A name is one session's at a time, and free again once it has ended.
  assert.match((await lab.tool("run", { steps: [{ new: "guest" }] })).text, /a session named "guest" is already open/);
  const ended = await lab.tool("run", { steps: [{ end: "guest" }, { new: "guest" }, { js: "document.title", on: "guest" }] });
  assert.equal(ended.isError, false, ended.text);
  assert.match(ended.text, /ended guest\nleft the server at .* running: another session is using it/);

  // Code opens one too, and holds it.
  const code = await lab.tool("run", { file: join(kit, "code", "two-sessions.ts") });
  assert.equal(code.isError, false, code.text);
  assert.match(code.text, /"first": "fixture",\s+"second": "other",\s+"cookie": "",\s+"width": 500/);
  assert.doesNotMatch((await lab.tool("list")).text, /^second /m);

  // Ending them all says once what became of the server they shared.
  const all = await lab.tool("end");
  assert.match(all.text, /ended guest\nended main\nstopped the server/);
  assert.doesNotMatch(all.text, /left the server/);
  await lab.close();
});

test("one worktree runs copies of its app side by side, each at its own address", async () => {
  const lab = weblab();
  const [first, second] = [await freePort(), await freePort()];
  const a = await lab.tool("new", { ...BASE, name: "a", address: first, start: "node server.mjs" });
  assert.equal(a.isError, false, a.text);
  assert.match(a.text, new RegExp(`^session a {2}at http://localhost:${first} \\(server started by weblab: node server\\.mjs\\)`));
  const b = await lab.tool("new", { ...BASE, name: "b", address: `localhost:${second}`, start: "node server.mjs" });
  assert.match(b.text, new RegExp(`^session b {2}at http://localhost:${second} `));
  // A third session at the first address joins that server.
  const c = await lab.tool("new", { ...BASE, name: "c", address: `http://localhost:${first}` });
  assert.doesNotMatch(c.text, /started the server/);

  const ran = await lab.tool("run", { session: "a", steps: [{ click: "#inc" }, { js: "location.port" }, { js: "location.port", on: "b" }, { js: "document.querySelector('#inc').textContent", on: "b" }] });
  assert.match(ran.text, new RegExp(`"${first}"\\nok {4}3 js on b \\(\\d+ms\\)\\n"${second}"\\nok {4}4 js on b \\(\\d+ms\\)\\n"count 0"`));

  assert.match((await lab.tool("end", { session: "a" })).text, /left the server at .* running: another session is using it/);
  assert.equal(await answers(`http://localhost:${first}`), true);
  assert.match((await lab.tool("end", { session: "c" })).text, new RegExp(`stopped the server at http://localhost:${first}`));
  assert.equal(await answers(`http://localhost:${first}`), false);
  assert.equal(await answers(`http://localhost:${second}`), true, "the other copy is untouched");
  await lab.close();
  assert.equal(await answers(`http://localhost:${second}`), false, "a weblab that exits ends its sessions");
});

test("a server someone else started is used as it is, and left running", async () => {
  const port = await freePort();
  const theirs = spawn("node", ["server.mjs"], { cwd: app, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  try {
    const origin = `http://localhost:${port}`;
    for (const deadline = Date.now() + 10_000; !(await answers(origin)) && Date.now() < deadline; ) await sleep(100);
    const lab = weblab();
    const opened = await lab.tool("new", { ...BASE, address: port });
    assert.equal(opened.isError, false, opened.text);
    assert.match(opened.text, new RegExp(`^session main {2}at ${origin}\\n`));
    assert.match((await lab.tool("end")).text, new RegExp(`left the server at ${origin} running, as weblab didn't start it`));
    await lab.close();
    assert.equal(await answers(origin), true);

    // Nothing there, and nothing to start it with: said, not guessed.
    const empty = await freePort();
    const nothing = weblab();
    const refused = await nothing.tool("new", { address: empty, dir: scratch });
    assert.equal(refused.isError, true);
    assert.match(refused.text, new RegExp(`nothing answers at http://localhost:${empty}, and .* has no dev script to start: give start`));
    assert.match((await nothing.tool("new", { dir: scratch })).text, /no address is known for .*, and it has no dev script to start: give address/);
    assert.match((await nothing.tool("new", { address: "not a place" })).text, /address: "not a place" isn't a URL, host:port, or a port/);
    // A command that fails says so, with what it printed.
    const crashed = await nothing.tool("new", { address: empty, start: "echo no such app; exit 3", dir: scratch });
    assert.match(crashed.text, /the server exited with code 3 before answering; see .*\n\s+no such app/);
    await nothing.close();
  } finally {
    theirs.kill();
  }
});

test("two weblabs share a server, the last to end stops it, and one that is killed is cleaned up after", async () => {
  const [one, two] = [weblab(), weblab()];
  const first = await one.tool("new", { ...BASE });
  const origin = originIn(first.text);
  const second = await two.tool("new", { ...BASE });
  assert.equal(originIn(second.text), origin);
  assert.doesNotMatch(second.text, /started the server/);
  assert.match(second.text, /server started by weblab/);

  assert.match((await one.tool("end")).text, /left the server at .* running: another session is using it/);
  assert.equal(await answers(origin), true);
  await one.close();
  assert.equal(await answers(origin), true);

  // Killed outright, it stops nothing; the next weblab to start does.
  two.child.kill("SIGKILL");
  await new Promise((done) => two.child.on("exit", done));
  assert.equal(await answers(origin), true);
  const next = weblab();
  await next.rpc("server/discover");
  assert.equal(await answers(origin), false, "what a killed weblab left is stopped");
  await next.close();
});

test("sessions opened at the same moment share one server, and leaving mid-open leaves nothing behind", async () => {
  const lab = weblab();
  // With no address, and by the address its .env names: one server either way.
  rmSync(join(app, ".env"), { force: true });
  const [a, b, c] = await Promise.all([lab.tool("new", { ...BASE, name: "a" }), lab.tool("new", { ...BASE, name: "b" }), lab.tool("new", { ...BASE, name: "c", path: "/other" })]);
  for (const opened of [a, b, c]) assert.equal(opened.isError, false, opened.text);
  const origin = originIn(a.text);
  assert.equal(originIn(b.text), origin);
  assert.equal([a, b, c].filter((opened) => /started the server/.test(opened.text)).length, 1);
  assert.match(c.text, /url {3}http:\/\/localhost:\d+\/other/);
  // An address written with a path goes there first.
  const d = await lab.tool("new", { ...BASE, name: "d", address: `${origin}/other` });
  assert.match(d.text, /title other/);
  // A failure on another session says which, once.
  const failed = await lab.tool("run", { session: "a", steps: [{ expect: "nowhere", on: "b", timeout: 200 }] });
  assert.match(failed.text, /FAIL {2}1 expect on b: expected the text "nowhere" to be visible/);
  const ended = await lab.tool("end");
  assert.equal((ended.text.match(/stopped the server/g) ?? []).length, 1);
  assert.equal(await answers(origin), false);
  await lab.close();

  // A client that goes while a session is still opening: its server is not left running.
  const hasty = weblab();
  void hasty.rpc("tools/call", { name: "new", arguments: { ...BASE } });
  await sleep(700);
  await hasty.close();
  const port = /^PORT=(\d+)$/m.exec(readFileSync(join(app, ".env"), "utf8"))?.[1];
  assert.equal(await answers(`http://localhost:${port}`), false);
});

test("a run that outlasts the call is left running, and the next call tells the rest", async () => {
  const lab = weblab();
  await lab.tool("new", { ...BASE });
  const early = await lab.tool("run", { steps: [{ js: "1" }, { wait: 1500 }, { js: "2" }], wait: 300 });
  assert.match(early.text, /ok {4}1 js \(\d+ms\)\n1\nstill running: step 2 \(wait\), \d+s in\. Call run on "main" again, with no steps, to wait for the rest\./);
  assert.match((await lab.tool("list")).text, /running step 2 \(wait\)/);
  // Steps given while it runs wait their turn, and a mistake in them costs the run nothing.
  const busy = await lab.tool("run", { steps: [{ js: "3" }], wait: 100 });
  assert.match(busy.text, /still running: step 2 \(wait\).*\nThe steps given now are queued after it\./);
  assert.match((await lab.tool("run", { steps: [{ clik: "x" }] })).text, /^weblab: step 1: unknown step "clik"/);
  const rest = await lab.tool("run", {});
  assert.match(rest.text, /ok {4}2 wait \(\d+ms\)\nok {4}3 js \(\d+ms\)\n2\nok {4}1 js \(\d+ms\)\n3/);
  assert.equal((rest.text.match(/1 js/g) ?? []).length, 1, "what was told already isn't told again");
  // And the session takes steps again.
  assert.match((await lab.tool("run", { steps: [{ js: "4" }] })).text, /ok {4}1 js \(\d+ms\)\n4/);
  await lab.close();
});

test("params fill steps and files, code hands back values, and a shot is held to one taken before", async () => {
  const lab = weblab();
  const dir = out();
  await lab.tool("new", { ...BASE, out: dir });
  const filled = await lab.tool("run", { steps: [{ js: "['${who=nobody}', ${count}]" }, { include: join(kit, "files", "greet.json") }], params: { count: 3, who: "ada" } });
  assert.equal(filled.isError, false, filled.text);
  assert.match(filled.text, /"ada",\s+3/);
  const unfilled = await lab.tool("run", { steps: [{ include: join(kit, "files", "greet.json") }] });
  assert.match(unfilled.text, /greet\.json: needs "who", which neither the include nor params gave/);

  const values = await lab.tool("run", { file: join(kit, "code", "values.ts") });
  assert.equal(values.isError, false, values.text);
  // The steps the code ran are shown under it with what they handed back, and what the code handed back after them.
  assert.match(values.text, /ok {4}1 playwright \(\d+ms\)\n {2}ok {4}1\.1 goto \(\d+ms\)\n {2}ok {4}1\.2 js \(\d+ms\)\n {2}"fixture"\n\{\s+"title": "fixture"\s+\}/);
  const thrown = await lab.tool("run", { file: join(kit, "code", "throws.ts") });
  assert.match(thrown.text, /FAIL {2}1 playwright: thrown by the code \(throws\.ts:4\)/);
  const inner = await lab.tool("run", { file: join(kit, "code", "fails.ts") });
  assert.match(inner.text, /FAIL {2}1 playwright: its step 2 \(expect\): deliberately missing/);
  const caught = await lab.tool("run", { file: join(kit, "code", "caught.ts") });
  assert.match(caught.text, /its step 5 \(expect\): the one that counts/);
  // A failure the code caught shows where it was, and the code went on.
  assert.match(caught.text, / {2}FAIL {2}1\.2 expect: .*\n {2}ok {4}1\.3 js/);
  assert.match(caught.text, /1\.3 js \(\d+ms\)\n {2}1\n/);
  const script = join(scratch, "check.ts");
  writeFileSync(script, `export default async ({ page, step, params }: any) => { await step({ goto: "/" }); await page.getByRole("button", { name: "count 0" }).click(); return [await page.locator("#inc").textContent(), params.n]; };`);
  assert.match((await lab.tool("run", { file: script, params: { n: 7 } })).text, /"count 1",\s+7/);

  // The same page again matches its earlier shot; a page that has changed doesn't, and what differs is kept.
  await lab.tool("run", { steps: [{ goto: "/" }, { shot: "now" }] });
  const before = join(dir, "shots", "main-now.png");
  assert.equal((await lab.tool("run", { steps: [{ goto: "/" }, { shot: { as: "again", matches: before } }] })).isError, false);
  const changed = await lab.tool("run", { steps: [{ click: "#inc" }, { shot: { as: "again", matches: before } }] });
  assert.match(changed.text, /the shot differs from .*main-now\.png in \d+ of 480000 pixels/);
  assert.ok(existsSync(join(dir, "shots", "main-again.diff.png")));
  assert.equal((await lab.tool("run", { steps: [{ shot: { as: "lenient", matches: before, tolerance: 0.5 } }] })).isError, false);
  await lab.close();
});

test("a video is recorded from when it starts, with the app ready, until it stops or the session ends", async () => {
  const lab = weblab();
  const dir = out();
  // Recording was an option of new, and is a step now: the option says so.
  assert.match((await lab.tool("new", { ...BASE, video: true, out: dir })).text, /no option "video"; record with the video step/);
  await lab.tool("new", { ...BASE, out: dir });
  assert.match((await lab.tool("run", { steps: [{ video: "stop" }] })).text, /FAIL {2}1 video: nothing is being recorded/);
  // On a page that hasn't mounted yet, ready and video both wait for the app.
  const mounted = "document.querySelector('#root').childElementCount > 0";
  const started = await lab.tool("run", { steps: [{ goto: { url: "/", ready: false } }, { ready: true }, { js: mounted }, { goto: { url: "/", ready: false } }, { video: "start" }, { js: mounted }, { video: "start" }] });
  assert.match(started.text, /ok {4}3 js \(\d+ms\)\ntrue\n/);
  assert.match(started.text, /ok {4}6 js \(\d+ms\)\ntrue\nFAIL {2}7 video: a video is being recorded already/);
  await lab.tool("run", { steps: [{ click: "#inc" }, { hover: "#ask" }] });
  // The cursor drawn for the recording isn't in a screenshot: it matches one from a session that has no cursor.
  await lab.tool("new", { ...BASE, name: "plain", out: dir });
  await lab.tool("run", { session: "plain", steps: [{ goto: "/other" }, { hover: "h1" }, { shot: "other" }] });
  const same = await lab.tool("run", { steps: [{ goto: "/other" }, { hover: "h1" }, { js: "getComputedStyle(document.querySelector('[data-weblab-cursor]')).visibility" }, { shot: { as: "other", matches: join(dir, "shots", "plain-other.png") } }] });
  assert.equal(same.isError, false, same.text);
  assert.match(same.text, /"visible"/);
  // Stopped, the video is written, and the page is left without the cursor.
  const stopped = await lab.tool("run", { steps: [{ video: "stop" }, { js: "document.querySelector('[data-weblab-cursor]') === null" }] });
  assert.match(stopped.text, /ok {4}2 js \(\d+ms\)\ntrue\n[\s\S]*file {2}.*videos\/main\.webm/);
  assert.ok(existsSync(join(dir, "videos", "main.webm")));
  // A tab the steps move to during a take is recorded too, even one closed before the take ends.
  const tabs = await lab.tool("run", { steps: [{ goto: "/" }, { video: "start" }, { click: "#pop" }, { tab: "new" }, { tab: { close: true } }, { video: "stop" }] });
  assert.match(tabs.text, /file {2}.*videos\/main-take2\.webm\nfile {2}.*videos\/main-take2-tab1\.webm/);
  // A take still going when its session ends is written then.
  await lab.tool("run", { steps: [{ video: { as: "again" } }, { click: "h1" }] });
  const ended = await lab.tool("end", { session: "main" });
  assert.match(ended.text, /video .*videos\/main-again\.webm/);
  assert.ok(existsSync(join(dir, "videos", "main-again.webm")));
  await lab.close();
});

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// A Chrome started the way an Electron app or a debuggable browser is: with a port to join it by.
async function runningChrome(name: string, title: string): Promise<{ port: number; stop(): void }> {
  const port = await freePort();
  const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, name)}`, "--headless=new", "--no-first-run", `data:text/html,<title>${title}</title><h1>${title}</h1><button onclick="this.textContent='pressed'">Press</button>`], { stdio: "ignore" });
  for (const deadline = Date.now() + 15_000; !(await answers(`http://127.0.0.1:${port}/json/version`)) && Date.now() < deadline; ) await sleep(100);
  return { port, stop: () => chrome.kill() };
}

test("two running apps are two sessions, joined by their ports and left as they were", { skip: !existsSync(CHROME) }, async () => {
  const [a, b] = await Promise.all([runningChrome("device-a", "Device A"), runningChrome("device-b", "Device B")]);
  try {
    const lab = weblab();
    const first = await lab.tool("new", { name: "a", attach: a.port });
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, new RegExp(`^session a {2}attached to ${a.port}\\n`));
    // It stays where it was: nothing is navigated, and no server is started.
    assert.doesNotMatch(first.text, /goto|started the server/);
    assert.match(first.text, /title Device A/);
    assert.equal((await lab.tool("new", { name: "b", attach: `localhost:${b.port}`, tab: "Device B" })).isError, false);
    // A second session on the very same tab is allowed, and said.
    const again = await lab.tool("new", { name: "a2", attach: a.port });
    assert.match(again.text, new RegExp(`note: "a" is driving this same tab of ${a.port}; steps on any of them act on the one tab\\. Give tab or newTab to drive another\\.`));
    await lab.tool("end", { session: "a2" });

    const ran = await lab.tool("run", { session: "a", steps: [{ click: "text=Press" }, { js: "document.querySelector('button').textContent" }, { js: "document.title", on: "b" }, { js: "document.querySelector('button').textContent", on: "b" }] });
    assert.match(ran.text, /"pressed"\nok {4}3 js on b \(\d+ms\)\n"Device B"\nok {4}4 js on b \(\d+ms\)\n"Press"/);
    // A running app's tab is recorded too, and left without the cursor drawn for it.
    const filmed = await lab.tool("run", { session: "a", steps: [{ video: "start" }, { hover: "button" }, { video: "stop" }, { js: "document.querySelector('[data-weblab-cursor]') === null" }] });
    assert.match(filmed.text, /ok {4}4 js \(\d+ms\)\ntrue\n[\s\S]*file {2}.*videos\/a\.webm/);
    assert.match((await lab.tool("new", { name: "c", attach: a.port, browser: "edge" })).text, /browser can't be used with attach/);
    assert.match((await lab.tool("new", { name: "c", attach: a.port, tab: "nonesuch" })).text, /no tab in the attached browser matches "nonesuch"/);

    await lab.tool("end");
    await lab.close();
    // Both are still up, with what the steps did still showing.
    assert.equal(await answers(`http://127.0.0.1:${a.port}/json/version`), true);
    assert.equal(await answers(`http://127.0.0.1:${b.port}/json/version`), true);
  } finally {
    a.stop();
    b.stop();
  }
});

// Playwright's own builds of the other engines, when they have been downloaded.
const installed = (engine: string) => {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    return readdirSync(cache).some((entry) => entry.startsWith(`${engine}-`));
  } catch {
    return false;
  }
};

test("the same steps run in WebKit and Firefox, each as a session beside the others", { skip: !installed("webkit") || !installed("firefox") }, async () => {
  const lab = weblab();
  await lab.tool("new", { ...BASE });
  for (const [browser, engine] of [["webkit", "AppleWebKit"], ["firefox", "Firefox"]] as const) {
    const opened = await lab.tool("new", { ...BASE, name: browser, browser });
    assert.equal(opened.isError, false, opened.text);
    const ran = await lab.tool("run", { session: browser, steps: [{ click: "#inc" }, { expect: { selector: "#inc", text: "count 1" } }, { js: "navigator.userAgent" }] });
    assert.equal(ran.isError, false, ran.text);
    assert.match(ran.text, new RegExp(engine));
    assert.match((await lab.tool("run", { session: browser, steps: [{ cdp: "Browser.getVersion" }] })).text, new RegExp(`cdp is the Chrome DevTools Protocol, which ${browser} doesn't speak`));
  }
  assert.match((await lab.tool("new", { name: "x", browser: "nonesuch" })).text, /no browser called "nonesuch" found/);
  await lab.close();
});

test("a server that puts itself in the background is still stopped, and an address it only mentions is not taken for it", async () => {
  const detached = weblab({ WEBLAB_TEST_DETACH: "1" });
  const opened = await detached.tool("new", { ...BASE });
  assert.equal(opened.isError, false, opened.text);
  assert.match(opened.text, /the server went into the background \(pid \d+\); weblab is keeping track of it/);
  const origin = originIn(opened.text);
  await detached.close();
  assert.equal(await answers(origin), false);

  // Someone else's server, whose address the app prints as it starts.
  const port = await freePort();
  const theirs = spawn("node", ["server.mjs"], { cwd: app, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  try {
    for (const deadline = Date.now() + 10_000; !(await answers(`http://localhost:${port}`)) && Date.now() < deadline; ) await sleep(100);
    rmSync(join(app, ".env"), { force: true });
    const lab = weblab({ WEBLAB_TEST_MENTION: `http://localhost:${port}`, WEBLAB_TEST_DELAY: "600" });
    const mine = await lab.tool("new", { ...BASE });
    assert.equal(mine.isError, false, mine.text);
    assert.notEqual(originIn(mine.text), `http://localhost:${port}`);
    await lab.close();
    assert.equal(await answers(`http://localhost:${port}`), true);
  } finally {
    theirs.kill();
  }
});

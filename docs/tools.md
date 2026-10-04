# Tools

This is the reference for weblab's MCP tools: `new`, `run`, `end` and `list`, which work with sessions, and `docs`, which hands back these pages. It lists every argument, what each reply holds, how weblab finds or starts the app, and where files go.

A reply is text for the agent to read as it is, with each screenshot as an image right after the step that took it. A reply is marked as an error (`isError`) when the call could not be done, a step that never ran (written wrong, or on a session that isn't open) included, and the text says why. A step that ran and failed is not an error but a result: its `FAIL` line says why, and its screenshot comes with it, which a client showing an error's text alone would leave out.

Examples show a tool's arguments as JSON, under the tool's name, and the reply text below them. `$TMPDIR` in a reply stands for the system's temp directory.

## new

Opens a session: a browser of its own (its own cookies, storage and tabs) pointing at an address, with a name. With no arguments it opens a session named `main` at the project's dev server, starting the server if it isn't running, and goes to `/`.

| Argument | What it says | Default |
| --- | --- | --- |
| `name` | What to call the session: what `run`, `end` and a step's `on` use. Letters, digits, dots, dashes and underscores, up to 32 characters. | `main`, then `session2`, `session3`, ... |
| `address` | Where the app answers: a URL, `host:port`, or a port (`4000` is `http://localhost:4000`). A path on a URL is where the session goes first, unless `path` says otherwise. See [How an address is resolved](#how-an-address-is-resolved). | The project's dev server |
| `start` | The command that starts the app when nothing answers at the address. It runs in the project directory with the address's port in `PORT`. | The project's `dev` script |
| `startTimeout` | How long a server weblab starts gets to answer, in milliseconds. | `60000` |
| `dir` | The project directory: where its `package.json`, dev script and `.env` are, and where relative paths in steps are read from. | Where weblab was started |
| `path` | Where to go first: a path, resolved against the address, or a full URL. | `/`; with `attach`, wherever the browser already is |
| `attach` | Join a browser or Electron app that is already running, by its remote debugging port or address, instead of launching one. See [attach](#attach). | Launch a browser |
| `tab` | With `attach`: which tab to drive, by part of its URL or title. | The first tab |
| `newTab` | With `attach`: open a new tab to drive, and leave the browser's own tabs alone. | `false` |
| `browser` | The browser to launch: `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `edge`, `edge-beta`, `edge-dev`, `chromium`, `brave`, `helium`, `vivaldi`, `arc`, `opera`, the name of any app in `/Applications` or `~/Applications`, or the path to a binary or `.app`. `webkit` (or `safari`) and `firefox` are Playwright's own builds of those engines. | `chrome` |
| `browserArgs` | Extra command-line flags for the browser it launches. | none |
| `headed` | Give the browser a window on the screen. | `false` (headless) |
| `persist` | Keep one browser profile for this project and browser between sessions. One session at a time can use it. | `false` |
| `state` | Start signed in: the name a `saveState` step saved cookies and storage under. | none |
| `viewport` | The page's size: `"1440x900"`, `"390x844@3"` with a pixel scale, or `{ "width", "height", "deviceScaleFactor" }`. | `1440x900` at 2x |
| `context` | Playwright [browser context options](https://playwright.dev/docs/api/class-browser#browser-new-context), as given: `{ "colorScheme": "dark", "locale": "de-DE", "isMobile": true, "permissions": [...] }`. | none |
| `trace` | Keep a Playwright trace, written when the session ends: `true`, or `"on-failure"` to keep it only if a step on this session failed. | `false` |
| `timeout` | How long each step may take, in milliseconds, unless the run or the step says otherwise. | `10000` |
| `ignore` | Regular expressions. Console output and failed requests that match are left out of the console log, the reply, and `noErrors` checks. | none |
| `ready` | What `goto`, `reload`, the `ready` step and a `video` starting wait for: `{ "selector" }`, `{ "text" }` or `{ "js" }` (an expression that turns true), each with an optional `timeout`. | `#root` or `#app` has children, or else the page has loaded |
| `out` | The directory this session's screenshots, logs and videos go to. | A shared directory under the temp directory; see [Files](#files) |

Some combinations are refused with a message saying why: `tab` and `newTab` need `attach`; `browser`, `browserArgs`, `persist`, `state`, `context` and `headed` can't be used with `attach`; `persist` and `state` can't be used together; a name that is already open is refused until that session ends.

### What `new` replies

```text
session main  at http://localhost:5173 (server started by weblab: bun run dev)
files $TMPDIR/weblab/shop-20261003-101600
started the server at http://localhost:5173 (bun run dev); it stops when the last session on it ends
ok    1 goto (566ms)
url   http://localhost:5173/
title Shop

console since the last reply:
  [console.log] app mounted (http://localhost:5173/src/main.tsx)
```

- The first line names the session and its address. `(server started by weblab: ...)` is there when the server is one weblab started, in this process or another. An attached session says `attached to 9222`, and `, at <address>` when it was given one.
- `files` is the directory the session writes to.
- Lines about the server follow, when there is something to say: that weblab started it, is waiting for another weblab that is starting it, or is keeping track of one that went into the background.
- The first `goto` is reported as step 1, as a `run` reports steps.
- Then where the page is (`url`, `title`), its tabs if it has more than one, and what the console logged.

When the session can't be opened, the reply is an error with the reason, such as `weblab: nothing answers at http://localhost:4000, and <project> has no dev script to start: give start, the command that starts it`. When it opens but the first page fails (it never becomes ready, say), the reply shows the failed `goto` and the session stays open.

### How an address is resolved

A session with an `address` points there. Whatever already answers at that address (any HTTP answer, a 404 included) is used as it is, and left running. If a server weblab started is already recorded there, the session joins it. If nothing answers, weblab runs `start` (or the project's `dev` script) with `PORT` set to the address's port, and waits up to `startTimeout` for the address to answer. A command that reads its port some other way has to be told in `start`: `"start": "pnpm vite --port 4101"`.

With no `address`, the session points at the project's own dev server:

1. The `PORT` line in the project's `.env`, if something answers there (or weblab has a server recorded there). Only that line is read; nothing else in the file is kept or printed.
2. Otherwise, a server weblab already started for this project with the same command, wherever it turned out to answer.
3. Otherwise, weblab starts the `dev` script and waits for it to answer at the `PORT` in `.env`, or at a `localhost` address it prints as it starts. An address it prints that something else already serves (an API the app calls) is not taken for the app.

The project is the nearest directory at or above `dir` with a `package.json`, looking no higher than the top of its git repository; in a monorepo that is the app's own folder. Its `dev` script runs with the package manager its lockfile names (`bun`, `pnpm`, `yarn` or `npm`), or the first of those installed.

### When a server is started, shared and stopped

- weblab starts a server only when nothing answers at the session's address.
- A server weblab started is shared by every session pointing at its address, in this weblab and in any other weblab process on the machine. A second session there joins it rather than starting another.
- It stops when the last session using it ends. `end` says which happened: `stopped the server at ...`, or `left the server at ... running: another session is using it, and the last one stops it`.
- A server weblab did not start is never stopped: `left the server at ... running, as weblab didn't start it`.
- A server that puts itself in the background and exits (as `astro dev` does) is followed by the port it listens on, and stopped all the same.
- When weblab exits, its sessions end and its servers are let go of the same way. If a weblab process is killed outright, the next weblab to start stops the servers it left that no live weblab is using.
- A server's output goes to `server-<host>-<port>.log` in the session's files directory (`server-<pid>-<n>.log` when the server chose its own address). When a server fails to start, the error names that log and quotes its last lines.

### attach

`attach` joins a browser or Electron app that was started with a remote debugging port, instead of launching one. It takes a port (`9222`, meaning `127.0.0.1:9222`), `host:port`, or a full `http://` or `ws://` address.

- The session drives the first tab that isn't one of the browser's own pages, the tab whose URL or title contains `tab`, or a new tab with `newTab`.
- It stays where it is: with no `path`, nothing is navigated. A `goto` with a path is resolved against `address` if one is given, else against the page's current origin, an Electron app's own scheme (`myapp://`) included.
- No server is started unless `address` or `start` is given.
- `viewport` resizes the tab only when given.
- When the session ends, weblab closes only the tabs it opened (its new tab, tabs its steps opened, and their popups) and lets go of the browser, which keeps running.
- A `video` step records the tab being driven, once it is ready: an app still loading isn't filmed blank.

[Sessions](sessions.md#running-browsers-and-electron-apps) has more, including how to start a browser or app with a port.

## run

Runs steps on a session, in order, stopping at the first that fails. The session stays open either way, with the page as the steps left it. [Steps](steps.md) lists every step.

| Argument | What it says | Default |
| --- | --- | --- |
| `session` | The session the steps are for. A step can say another with `on`. | `main` |
| `steps` | A list of steps, or one step: `[{ "click": "text=Save" }]` or `{ "click": "text=Save" }`. | |
| `file` | A file of steps to run in place of `steps`: a JSON file of steps, or a `.ts`, `.mts`, `.js` or `.mjs` file whose default export runs them ([Code](code.md#code-files)). A relative path is read from the session's project directory. | |
| `params` | Values for `${name}` placeholders in the steps or the file, also handed to code as `params`. See [Placeholders](steps.md#placeholders). | none |
| `timeout` | How long each step may take, in milliseconds, unless the step says. | The session's `timeout` |
| `wait` | How long this call waits before it replies with steps still running, in milliseconds. See [Runs that outlast the call](#runs-that-outlast-the-call). | `45000` |

Give `steps` or `file`, not both. A step that is written wrong (an unknown step, two actions in one object, an `include` whose file is missing) stops the whole call before anything runs, with the reason and the nearest step name when it looks like a typo:

```text
weblab: step 1: unknown step "clik" (did you mean "click"?); every step is listed in the run tool's description
```

### What `run` replies

`run`

```json
{ "steps": [{ "click": "#inc" }, { "js": "document.querySelector('#inc').textContent" }, { "look": { "selector": "h1" } }, { "shot": "home" }] }
```

```text
ok    1 click (35ms)
ok    2 js (4ms)
"count 1"
ok    3 look (11ms)

- heading "Fixture app" [level=1] [ref=e2]

ok    4 shot (82ms)
shot  $TMPDIR/weblab/fixture-20261003-101600/shots/main-home.png
```

In order, a reply holds:

1. Lines that belong to no one step: a server started, a session a step ended (`ended guest`, its `video` and `trace`, what became of its server), a state saved (`state ada saved`).
2. Each step: `ok    <n> <action> (<ms>ms)`, or `FAIL  <n> <action>: <why>`. A step on another session says so (`ok    3 js on b (4ms)`), and a step an `include` brought in names its file (`ok    5 fill (sign-in.json step 1)`).
3. Under a step, what it handed back: a `look`'s text as it is, between blank lines, and any other value (from `js`, `playwright`, `cdp`) as JSON. A value longer than 8000 characters is cut short, with a count of what was left out.
4. Under a step, `note  ...` for something worth knowing about a step that passed: a `goto` whose page answered 404, lazy images still loading when a full-page shot was taken.
5. `shot  <path>` for each screenshot, and `file  <path>` for other files the steps wrote (a named `look`, a video `stop` wrote).
6. `url` and `title`, when they changed since the last reply about this session.
7. The tabs, as `tab 0* <url>`, `tab 1  <url>` (the `*` marks the one steps act on), when there is more than one and they changed.
8. `console since the last reply:` and what the page logged since then: console messages, page errors, failed requests, responses with an error status, and dialogs. At most the last 40 lines are shown, with the path of the full log when there were more. The same line repeated shows once with a count, `(x12)`.

Each screenshot comes back as an image, placed right after the lines of the step that took it, so several in one reply are told apart. Up to six per reply are sent, leaving out any over 4 MB; their paths are in the text either way.

### When a step fails

```text
ok    1 click (35ms)
FAIL  2 expect: the greeting is missing (expected the text "not there" to be visible)
shot  $TMPDIR/weblab/fixture-20261003-101600/shots/main-FAIL-2-expect.png
```

The steps after it don't run. The reply carries a screenshot of the page as it was when the step failed. A step's `message` leads the reason, and what actually happened follows in brackets. A step that failed on another session starts with `on <name>:`. A step that a code step ran says which (`its step 2 (expect): ...`), and an error thrown by a code file is given whole (an assertion's diff included) and names its file and line (`(check.ts:12)`).

A step whose options are wrong (a misspelt option, a ref no `look` printed) fails without a screenshot, since it says nothing about the page:

```text
FAIL  1 click: click: no option "buton" (did you mean "button"?); it takes button, count, modifiers, position, force, x, y, and a target
```

### Runs that outlast the call

Some clients give a tool call about a minute. A `run` that takes longer than `wait` replies with what is done so far and leaves the rest running:

```text
ok    1 js (3ms)
1
still running: step 2 (wait), 0s in. Call run on "main" again, with no steps, to wait for the rest.
```

- Calling `run` on that session again with no steps waits (up to `wait` again) and replies with the rest. A step is reported once it has finished, never twice.
- Calling `run` with new steps while it is still running reports progress and adds `The steps given now are queued after it.` They run when the earlier run finishes, and a later `run` with no steps replies with their results.
- If the earlier run has finished by then, its results come first, and the new steps run in the same call.
- `list` shows `running step 2 (wait)` for a session with steps under way, and `a run has finished: call run with no steps for its results` once they are done.

Calls on one session run one after another, in the order they came. Calls on different sessions run side by side.

## end

Ends a session: its browser closes, a video still being recorded and its trace are written, and a server weblab started for it stops if no other session is using it.

| Argument | What it says | Default |
| --- | --- | --- |
| `session` | The session to end. | Every session |

`end`

```json
{ "session": "main" }
```

```text
ended main
video $TMPDIR/weblab/shop-20261003-101600/videos/main.webm
stopped the server at http://localhost:5173
files $TMPDIR/weblab/shop-20261003-101600
still open: guest
```

Each ended session gets `ended <name>`, then `video` and `trace` lines when it had them, and what became of its server. Then the files directories, and the sessions still open. With nothing open, the reply is `no session is open`. A name that isn't open is an error that lists the ones that are.

A session can also be ended by a step (`{ "end": "guest" }`), and every session ends when weblab exits.

## list

The sessions that are open. It takes no arguments.

```text
main  at http://localhost:5173 (server started by weblab: bun run dev)
  url   http://localhost:5173/other
  title other
  files $TMPDIR/weblab/shop-20261003-101600
guest  at http://localhost:5173 (server started by weblab: bun run dev)
  url   http://localhost:5173/
  running step 4 (expect)
  files $TMPDIR/weblab/shop-20261003-101600
```

With nothing open, the reply is `no session is open`.

## Files

A session writes what it captures to one directory, which `new`, `end` and `list` all print as `files`. weblab writes nothing into the project.

- With `out`, that directory.
- Without it, a directory under the system's temp directory, made when the first such session opens and shared by every later session in this weblab that has no `out`: `$TMPDIR/weblab/<project>-<YYYYMMDD-HHMMSS>`. `<project>` is the repository's name, plus the worktree's name when it differs, plus the app's folder in a monorepo.
- A session a `new` step opens writes where the session the step ran on does.

Every file is named after its session, so sessions sharing a directory never write over each other:

| Path | What it holds |
| --- | --- |
| `shots/<session>-<name>.png` | A `shot` step's screenshot. |
| `shots/<session>-<name>.diff.png` | What differs, in red, when a `shot` with `matches` failed. |
| `shots/<session>-FAIL-<n>-<action>.png` | The page when step `n` failed; `FAIL-<n>.<m>-<action>` for step `m` of a code step. |
| `looks/<session>-<name>.yml` | A `look` given a name (`.txt` for `format: "text"`, `.html` for `format: "html"`). |
| `console/<session>.log` | Each step as it ran, everything the page logged, page errors, failed requests, error responses, dialogs and how they were answered, and why a step failed. |
| `network/<session>.log` | Every response (status, method, URL, with `(mocked)` on those a `mock` answered), and each WebSocket opened and closed. |
| `videos/<session>.webm` | A `video` step's first take. Later ones are `<session>-take<n>.webm`, or `<session>-<as>.webm` when named. A tab the steps moved to during a take gets `-tab<n>` after its name. With `FFMPEG` set, an `.mp4` lands beside each. |
| `traces/<session>.zip` | With `trace`. Open it at [trace.playwright.dev](https://trace.playwright.dev). |
| `server-<host>-<port>.log` | The output of a server weblab started. |

A name used again after its session ended gets a number, so the earlier files stay: `guest-2.log`, `shots/guest-2-home.png`.

weblab saves no downloads by itself. Code can save one into the session's directory, `ctx.artifacts.dir`; [Recipes](recipes.md#upload-and-download-files) shows how.

weblab's own records live outside every repository, in `$XDG_STATE_HOME/weblab` (`~/.local/state/weblab` by default): the servers it started, locks, sign-ins saved by `saveState` (under `auth/`), and profiles kept by `persist` (under `profiles/`).

## Starting weblab

An MCP client starts weblab and talks to it over stdin and stdout; see the [README](../README.md#register-it-with-an-mcp-client). Run by hand, `weblab --version` prints its version and `weblab --help` how to register it. When the client closes weblab's stdin, weblab ends every session and exits. What code run by a step prints with `console.log` goes to weblab's stderr, not into a reply.

| Variable | What it does |
| --- | --- |
| `WEBLAB_WAIT_MS` | The default for `run`'s `wait`, in milliseconds. |
| `FFMPEG` | An ffmpeg binary. With it, each video also gets an `.mp4`. |
| `TMPDIR` | Where the shared files directory goes, under `weblab/`. |
| `XDG_STATE_HOME` | Where weblab keeps its own records, under `weblab/`. |
| `WEBLAB_INSTALL_DIR` | Where `install.sh` puts the binary. Defaults to `~/.local/bin`. |

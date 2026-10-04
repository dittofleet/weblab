# Sessions

This page covers working with more than one session: two users, a session opened by a step, copies of an app on several ports, running browsers and Electron apps, other browser engines, saved sign-ins and kept profiles.

A session is a named browser of its own, with its own cookies, storage and tabs, pointing at an address. Any number can be open at once, and each is opened and ended on its own. The only thing sessions can contend for is an address: whatever answers at a session's address is used as it is, and when nothing does, weblab starts the app there, shares that server among every session pointing at it, and stops it when the last one ends ([Tools](tools.md#when-a-server-is-started-shared-and-stopped) has the details).

Tabs are not sessions. The tabs of one session share its cookies; the [`tab`](steps.md#getting-around) step switches between them. Two sessions share nothing but, when they point at the same address, a server.

## Two users

Two sessions at the same address are two users of one app. Open them with the `new` tool:

`new`

```json
{ "path": "/room/1" }
```

`new`

```json
{ "name": "guest", "path": "/room/1" }
```

The second joins the server the first started. Then any step says which session it is for with `on`, and `run`'s `session` says which one the rest are for:

`run`

```json
{
  "steps": [
    { "fill": { "label": "Message", "value": "hello" } },
    { "press": "Enter" },
    { "expect": "hello", "on": "guest" },
    { "shot": "received", "on": "guest" }
  ]
}
```

```text
ok    1 fill (22ms)
ok    2 press (15ms)
ok    3 expect on guest (140ms)
ok    4 shot on guest (88ms)
shot  $TMPDIR/weblab/chat-20261003-101600/shots/guest-received.png
```

A step that fails on another session says so (`FAIL  3 expect on guest: ...`), and the failure's screenshot is of that session's page. Each session keeps its own console and network logs, named after it.

## A `new` step, and what it inherits

A [`new` step](steps.md#more-than-one-session) opens a session in the middle of a run. It takes every argument the `new` tool takes, and what it doesn't say is as the session the step is on (the step's `on`, else the run's session):

| Taken from that session | Never taken |
| --- | --- |
| The project (`dir`), where files go (`out`), and the address it is pointed at, or, for a session attached to a browser, the `http` or `https` site its page is on | `name` |
| `start`, `startTimeout` and `ready` | `attach`, `tab`, `newTab` |
| `browser`, `browserArgs` and `headed` | `state` and `persist`: a second session is a second user |
| `viewport`, `timeout`, `ignore` and `trace` | `path`: it goes to `/` unless the step says |
| `context`, with the step's own keys laid over it | |

A `new` step that gives `attach` takes nothing but the project and where files go.

`run`

```json
{
  "steps": [
    { "click": "#signin" },
    { "new": { "name": "guest", "path": "/other" } },
    { "expect": "Other page", "on": "guest" },
    { "goto": "/", "on": "guest" },
    { "expect": { "selector": "#signed", "text": "signed out" }, "on": "guest" }
  ]
}
```

The session a step opens is an ordinary session: it stays open after the run, `list` shows it, and `run` and `end` take its name. A name is one session's at a time; once that session has ended, it is free again.

## Copies of an app on several ports

One project can run several copies of its app, each at its own address, each with its own sessions. Give each an `address` and the command that starts it; weblab runs the command with the port in `PORT`:

`new`

```json
{ "name": "a", "address": 4101, "start": "node server.mjs" }
```

`new`

```json
{ "name": "b", "address": "localhost:4102", "start": "node server.mjs" }
```

```text
session b  at http://localhost:4102 (server started by weblab: node server.mjs)
files $TMPDIR/weblab/shop-20261003-101600
started the server at http://localhost:4102 (node server.mjs); it stops when the last session on it ends
ok    1 goto (412ms)
url   http://localhost:4102/
title Shop
```

A third session at the first address joins that copy rather than starting another:

`new`

```json
{ "name": "c", "address": "http://localhost:4101" }
```

Steps go to either copy with `on`:

`run`

```json
{ "session": "a", "steps": [{ "click": "#inc" }, { "js": "location.port" }, { "js": "location.port", "on": "b" }] }
```

```text
ok    1 click (30ms)
ok    2 js (3ms)
"4101"
ok    3 js on b (4ms)
"4102"
```

Ending `a` leaves the server at 4101 running for `c` (`left the server at http://localhost:4101 running: another session is using it, and the last one stops it`); ending `c` stops it. The copy at 4102 is untouched.

A dev server that doesn't read `PORT` is told its port in `start`: `"start": "pnpm vite --port 4101"`. To run two worktrees side by side, give each session its worktree's `dir`; each gets its own server.

Other weblab processes on the machine (another agent's, say) share servers the same way: a second weblab whose session points at an address where weblab started a server joins it, and the server stops when the last session in any of them ends.

## Running browsers and Electron apps

`attach` joins a browser or app that is already running, over the remote debugging port it was started with, instead of launching one. That covers what a fresh browser can't:

- **An Electron app.** Its windows are Chromium pages, so every step works on them, and `js` can call whatever the app puts on `window`. With `inspect`, code runs in its [main process](#the-main-process) too.
- **A browser that is already set up**, signed in to accounts a test needs, or with extensions.

### Starting it with a debugging port

Choose a free port yourself, and attach only to a browser or app you started.

```sh
# Chrome, with a profile of its own so the everyday one is left alone
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile

# An Electron app that passes switches through to Chromium
/Applications/MyApp.app/Contents/MacOS/MyApp --remote-debugging-port=9222
```

An Electron app that doesn't take the switch can turn it on itself with `app.commandLine.appendSwitch("remote-debugging-port", port)` before the app is ready.

An app started by its dev tooling gets the flags through it. With Electron Forge, what comes after `--` reaches the app: `electron-forge start -- --remote-debugging-port=9222 --inspect=9229`. Forge's own `--inspect-electron` always uses port 9229. A launch script of the app's own may need to pass them on.

weblab can start the app itself, and stop it when the session ends: give the debugging port as `address` as well, and the command as `start`, which gets the port in `PORT`:

`new`

```json
{ "name": "app", "attach": 9222, "address": 9222, "inspect": 9229, "start": "pnpm electron-forge start -- --remote-debugging-port=$PORT --inspect=9229" }
```

An app started by hand that exits at once with `Cannot find module 'electron'` was run as plain Node: the shell has `ELECTRON_RUN_AS_NODE` set, as one opened from another Electron app (an editor, say) can. Start it with `env -u ELECTRON_RUN_AS_NODE` in front. A command weblab starts never gets it.

### Driving it

`new`

```json
{ "name": "app", "attach": 9222, "tab": "myapp://" }
```

```text
session app  attached to 9222
files $TMPDIR/weblab/myapp-20261003-101600
url   myapp://main/index.html
title My App
```

`attach` takes a port, `host:port`, or a full `http://` or `ws://` address. `tab` picks the tab whose URL or title contains it; without it, the first tab that isn't one of the browser's own pages. `newTab` opens a fresh tab to drive instead, and leaves the browser's own alone.

- **It stays where it is.** With no `path`, nothing is navigated. A `goto` with a path is resolved against `address` if one was given, else the page's current origin, an app's own scheme included.
- **No server is started** unless `address` or `start` is given.
- **It isn't a clean slate.** Cookies, storage and whatever the app has open are real, which is the point, and a step can change them.
- **Some options don't apply**, because they describe a browser weblab would launch: `browser`, `browserArgs`, `persist`, `state`, `context` and `headed` are refused. `viewport` resizes the tab only when given.
- **It has a window**, so [`screen` shots](steps.md#the-real-screen) capture its native menus.
- **A [`video`](steps.md#recording-a-video) records the tab being driven**, with the drawn cursor. It starts once the app is ready, so a window still loading a fresh dev build isn't filmed blank. A [`ready`](steps.md#getting-around) step waits for the same without recording.
- **Two sessions can join the same tab.** Each drives it, so a step on one shows on the other; the reply to the second `new` says so. Give `tab` or `newTab` to drive another.
- **It is left as it was found.** When the session ends, weblab closes only the tabs it opened (its new tab, tabs its steps opened, and their popups), and lets go. The browser and its own tabs keep running.

Two windows of a desktop app, or two apps that talk to each other, are two sessions, each attached by its own port:

`new`

```json
{ "name": "a", "attach": 9241 }
```

`new`

```json
{ "name": "b", "attach": 9242 }
```

`run`

```json
{ "session": "a", "steps": [{ "click": "text=Send invite" }, { "expect": "Invitation from A", "on": "b" }] }
```

### The main process

An Electron app's main process owns its windows, menus, native dialogs and IPC, which no step in a window can reach. Started with `--inspect` as well, the app opens a Node debugger on a port of its own, and `inspect` joins it beside the window:

```sh
/Applications/MyApp.app/Contents/MacOS/MyApp --remote-debugging-port=9222 --inspect=9229
```

`new`

```json
{ "name": "app", "attach": 9222, "inspect": 9229 }
```

```text
session app  attached to 9222, main process at 9229
```

Then [`electron`](code.md#electron-the-apps-main-process) steps run code there, and what the main process logs shows in the reply beside what the window logs:

`run`

```json
{ "session": "app", "steps": [{ "electron": "stub(dialog, 'showMessageBox', async () => ({ response: 1 }))" }, { "click": "text=Delete" }, { "expect": "Kept" }] }
```

What `stub` replaces is put back when the session ends. Anything else the code changes stays changed until the app restarts. The port stays open as long as the app runs, to anything on the machine. When the app quits or restarts, the session says so on its next step. End it and open it again. [Code](code.md#electron-the-apps-main-process) has the rest.

## Other browsers and engines

By default a session launches the Google Chrome already installed, headless. `browser` picks another installed Chromium browser: `edge`, `brave`, `chromium`, `helium`, `vivaldi`, `arc`, `opera`, the Chrome and Edge beta, dev and canary channels, the name of any app in `/Applications`, or a path to a binary or `.app`. weblab never downloads one of these.

For what only shows in another engine, `"browser": "webkit"` (or `"safari"`) and `"browser": "firefox"` run the same steps there. These are Playwright's own builds of the engines, not the Safari or Firefox installed on the machine. Each is a one-time download, and a session that needs one says the exact command, such as:

```text
weblab: webkit needs Playwright's own build of it, a one-time download: bunx playwright-core@1.63.0 install webkit
```

Each engine can be a session beside the others, so one set of steps can be run in all three:

`new`

```json
{ "name": "webkit", "browser": "webkit" }
```

`run`

```json
{ "session": "webkit", "steps": [{ "click": "#inc" }, { "expect": { "selector": "#inc", "text": "count 1" } }, { "js": "navigator.userAgent" }] }
```

What belongs to Chromium doesn't work in WebKit or Firefox: the `cdp` step (`cdp is the Chrome DevTools Protocol, which webkit doesn't speak`), `screen` shots, `attach`, and `browserArgs` written for Chrome.

`headed` gives a launched browser a window on the screen, which helps when someone is watching, and is what a `screen` shot needs. Sessions launched with the same `browser`, `browserArgs` and `headed` share one browser process, each in a context of its own.

## Saved sign-ins

Sign in once, save the session's cookies and storage under a name with `saveState`, and start later sessions from it with `state`:

`run`

```json
{
  "steps": [
    { "goto": "/login" },
    { "fill": { "label": "Email", "value": "ada@example.com" } },
    { "fill": { "label": "Password", "value": "hunter2" } },
    { "click": { "role": "button", "name": "Sign in" } },
    { "expect": { "url": "/account" } },
    { "saveState": "ada" }
  ]
}
```

`new`

```json
{ "name": "ada", "state": "ada", "path": "/account" }
```

- Saved states are kept per project in weblab's own directory (`~/.local/state/weblab/auth/`), never in a repository or a files directory, since they hold live credentials.
- Cookies and storage belong to an origin, so a state saved against `localhost:4625` applies to an app on that same port.
- A `new` step never passes its session's sign-in on: a second session is a second user. Give it `state` to start it signed in.
- A name nothing was saved under is refused: `no saved state named "nobody" for <project>; a saveState step saves one`.

To carry a sign-in from a browser that is already signed in, attach to it once and run `saveState`.

## Kept profiles

`persist` keeps one browser profile for the project and browser, used by every session opened with `persist`. Whatever the app keeps in the browser survives between sessions: a sign-in, and also caches, IndexedDB, service workers and permissions granted.

- One session at a time can use a profile. A second is refused while the first is open, in this weblab or another.
- It can't be combined with `state` or `attach`.
- A `new` step doesn't pass it on.

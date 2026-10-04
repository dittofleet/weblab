<img src="assets/icon.svg" width="80" alt="weblab icon">

# weblab

weblab is an MCP server that drives real browsers, so AI agents can test and explore web apps. An agent opens named sessions (each a browser of its own pointing at an address), runs steps on them, and reads back what happened as text and screenshots.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/dittofleet/weblab/main/install.sh | sh
```

This puts one binary at `~/.local/bin/weblab` (set `WEBLAB_INSTALL_DIR` to change that). weblab runs on macOS, on Apple silicon and Intel, and drives a browser already on the machine: Google Chrome by default, or another Chromium browser.

To update, run `weblab update`. A running weblab looks for a newer release once a day, and says so in the reply to `new` when there is one.

## Register it with an MCP client

weblab speaks MCP over stdio, so the client starts it:

```sh
claude mcp add weblab -- weblab
codex mcp add weblab -- weblab
```

In a client's JSON config, the server entry is `{ "command": "weblab" }`. Sessions last as long as that weblab process does: when the client goes, every session ends, and a server weblab started for them stops unless another weblab is still using it.

## The tools

| Tool | What it does |
| --- | --- |
| `new` | Opens a session: a browser of its own, with a name, pointing at an address. Starts the app's dev server if nothing answers there. |
| `run` | Runs steps on a session, in order, stopping at the first that fails. Replies with each step's outcome, what it handed back, and its screenshots. |
| `end` | Ends one session, or all of them. Writes videos and traces, and stops a server nobody else is using. |
| `list` | The sessions that are open, where each one is, and whether steps are running on it. |
| `docs` | The reference pages below, readable from inside the client. They are also offered as MCP resources (`weblab://docs/<page>`). |

## An example

`new`

```json
{ "path": "/settings" }
```

```text
session main  at http://localhost:5173 (server started by weblab: pnpm run dev)
files $TMPDIR/weblab/shop-20261003-101600
started the server at http://localhost:5173 (pnpm run dev); it stops when the last session on it ends
ok    1 goto (1840ms)
url   http://localhost:5173/settings
title Settings

console since the last reply:
  [console.log] app mounted (http://localhost:5173/src/main.tsx)
```

`run`

```json
{
  "steps": [
    { "click": { "role": "button", "name": "Appearance" } },
    { "click": { "label": "Dark" } },
    { "expect": { "js": "document.documentElement.classList.contains('dark')" } },
    { "js": "localStorage.getItem('theme')" },
    { "shot": "appearance" }
  ]
}
```

```text
ok    1 click (41ms)
ok    2 click (37ms)
ok    3 expect (12ms)
ok    4 js (3ms)
"dark"
ok    5 shot (95ms)
shot  $TMPDIR/weblab/shop-20261003-101600/shots/main-appearance.png
```

The screenshot also comes back as an image in the same reply. A step that fails is shown as `FAIL  3 expect: ...` with a screenshot of the page at that moment, and the session stays open for the next call.

## What it can do

- Start the app's dev server when nothing answers at its address, share it among every session pointing there, and stop it when the last one ends. A server it didn't start is used as it is and left running.
- Run any number of sessions at once: two users, copies of an app on several ports, Chrome, Edge, WebKit and Firefox side by side.
- Join a browser or Electron app that is already running, and leave it as it was found.
- Read the page as an accessibility tree with refs to act on, as text, or as HTML.
- Act and check: click, type, fill, drag, upload, and `expect` waits for text, elements, URLs, requests, console messages or any JavaScript.
- Shape what the page sees: fake API responses, colour scheme, viewport, locale, a saved sign-in, a slow network.
- Run JavaScript in the page, Playwright code against it, or raw Chrome DevTools Protocol commands, for anything the built-in steps don't cover.
- Keep screenshots, compare one with an earlier one, capture native menus from the real screen, record video and Playwright traces, and log the console and network.

## Documentation

| Page | What's in it |
| --- | --- |
| [Tools](docs/tools.md) | Every argument of `new`, `run`, `end` and `list`, what each reply holds, servers, attaching, long runs, and where files go. |
| [Steps](docs/steps.md) | Every step and its options, targeting elements, refs, `expect`, `include` and placeholders. |
| [Sessions](docs/sessions.md) | More than one session: two users, copies of an app, running browsers and Electron apps, other engines, saved sign-ins. |
| [Code](docs/code.md) | `js`, `css`, `playwright` and `cdp`, and step files written as code. |
| [Recipes](docs/recipes.md) | Short answers to common tasks, as the steps to run. |

## Development

```sh
bun install
bun test              # end-to-end tests, in the installed Chrome
bun run build         # dist/weblab, a single binary
```

`src/main.ts` is the entry point and `src/mcp.ts` defines the tools. Each step lives in `src/steps/`, grouped as [Steps](docs/steps.md) lists them. Pushing a `v*` tag builds and publishes a release.

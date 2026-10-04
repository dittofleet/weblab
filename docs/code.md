# Code

This page covers the five steps that run code, and step files written as code. The named steps cover what is done all the time: go somewhere, click, fill, check, take a screenshot. Code covers everything else: anything a browser can do, weblab can do with code. Reach for it whenever no named step fits; there is no need to bend a step into shape.

| Step | Runs | Good for |
| --- | --- | --- |
| `js` | JavaScript inside the page, as the page's own code would | Reading the app's state, calling its APIs, setting storage, measuring layout |
| `css` | A stylesheet added to the page | Hiding toasts, dev toolbars and whatever changes from run to run, before a screenshot |
| `playwright` | [Playwright](https://playwright.dev/docs/api/class-page) code driving the page from outside | Anything the named steps don't do: precise mouse paths, the clock, downloads, popups, permissions, PDFs |
| `cdp` | One raw [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) command | What even Playwright doesn't offer: network and CPU throttling, performance metrics, vision deficiencies |
| `electron` | JavaScript in an attached Electron app's main process | What the app's windows can't reach: native dialogs, menus, windows themselves, IPC handlers |

`js`, `playwright`, `cdp` and `electron` hand back what they return. The reply prints it as JSON under the step, and in code, `await step(...)` returns it.

## js: inside the page

`js` takes an expression and runs it in the page; a promise it gives is awaited. It sees `window`, `document`, and everything the app puts on them. For several statements, wrap them in a function: `(() => { ...; return x })()`. A longer script can live in a file: `{ "js": { "file": "measure.js" } }`.

`run`

```json
{
  "steps": [
    { "js": "document.title" },
    { "js": "window.app.store.getState().cart.items.length" },
    { "js": "localStorage.setItem('onboarded', '1')" },
    { "reload": true },
    { "js": "getComputedStyle(document.querySelector('header')).position" },
    { "js": "[...document.querySelectorAll('a')].map(a => a.href)" }
  ]
}
```

A check can be any JavaScript too: `{ "expect": { "js": "window.app.ready === true" } }` waits until it is true, and if it never is, says what it was.

## css: change how the page looks

`run`

```json
{
  "steps": [
    { "css": "[data-sonner-toaster], .toast { display: none !important }" },
    { "css": "astro-dev-toolbar, vite-error-overlay { display: none !important }" },
    { "css": ".avatar img, time { visibility: hidden }" }
  ]
}
```

The stylesheet stays for the rest of the session, through reloads and in new tabs. Screenshots already finish CSS animations by themselves; see [`shot`](steps.md#reading-and-capturing).

## playwright: the whole Playwright API

`playwright` takes the body of an async function, and hands back what it returns. It is handed:

| Name | What it is |
| --- | --- |
| `page`, `context` | Playwright's [page](https://playwright.dev/docs/api/class-page) (the tab steps act on) and [browser context](https://playwright.dev/docs/api/class-browsercontext) (the session's browser). |
| `step(step)` | Runs any weblab step and hands back its value: `await step({ shot: "after" })`. It throws if the step fails. |
| `newSession(options)` | Opens another session, as the [`new` step](steps.md#more-than-one-session) does, and hands it back to drive. See [Another session](#another-session). |
| `locate(target, { all })` | A weblab [target](steps.md#targets) (a ref, a role, a label, a selector) as a Playwright locator: the first match, or every match with `{ all: true }`. |
| `cdp(method, params)` | A raw CDP command, as the `cdp` step sends it. |
| `electron(code, arg)` | Runs code in the app's main process, as the [`electron` step](#electron-the-apps-main-process) does. Given a function, calls it with the electron module and `arg`: `await electron(({ app }, name) => app.setName(name), "Test")`. |
| `logs` | What the session's tabs have logged so far: `{ type, text, url }` entries, console messages and page errors, past what is ignored. With `inspect`, what the main process logged too, marked `process: "main"`. |
| `responses` | Every response so far: `{ status, method, url, mocked }`. |
| `origin` | Where the app answers, for building URLs. |
| `params` | The `params` given to `run`. |
| `ctx` | Everything else weblab knows about the session, such as `ctx.name`, and `ctx.artifacts.dir`, its files directory. |

Playwright calls in the code get the step's timeout as their default.

Some of what it opens up:

`run`

```json
{
  "steps": [
    { "playwright": "await locate('e12').focus(); await page.keyboard.press('ControlOrMeta+a')" },
    { "playwright": "await locate('e12').dispatchEvent('pointerenter')" },
    { "playwright": "await page.mouse.move(200, 300); await page.mouse.down(); await page.mouse.move(400, 300, { steps: 30 }); await page.mouse.up()" },
    { "playwright": "await page.keyboard.insertText('pasted all at once')" },
    { "playwright": "await page.clock.setFixedTime(new Date('2026-12-24T09:00:00'))" },
    { "playwright": "await context.setOffline(true)" },
    { "playwright": "await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 51.5, longitude: -0.12 })" },
    { "playwright": "await context.addInitScript(() => { window.FEATURE_FLAGS = { beta: true } })" },
    { "playwright": "await page.emulateMedia({ reducedMotion: 'reduce' })" },
    { "playwright": "await page.waitForFunction(() => document.fonts.status === 'loaded')" },
    { "playwright": "const [popup] = await Promise.all([context.waitForEvent('page'), locate('text=Sign in with GitHub').click()]); return popup.url()" }
  ]
}
```

Anything in [Playwright's API](https://playwright.dev/docs/api/class-page) works the same way. Code with `on` (`{ "playwright": "...", "on": "guest" }`) gets that session's page, and its `step()` calls are for that session.

## cdp: the protocol underneath

Chromium browsers are driven over the Chrome DevTools Protocol, and Playwright is a layer on top of it. `cdp` sends one command straight to the protocol, on a connection weblab keeps open for the tab, so settings made with it stay in force across steps. It works in Chromium browsers only, not in WebKit or Firefox.

`run`

```json
{
  "steps": [
    { "cdp": { "method": "Network.emulateNetworkConditions", "params": { "offline": false, "latency": 400, "downloadThroughput": 50000, "uploadThroughput": 20000 } } },
    { "cdp": { "method": "Emulation.setCPUThrottlingRate", "params": { "rate": 4 } } },
    { "cdp": "Performance.enable" },
    { "cdp": "Performance.getMetrics" },
    { "cdp": { "method": "Emulation.setEmulatedVisionDeficiency", "params": { "type": "deuteranopia" } } },
    { "cdp": { "method": "Network.setBlockedURLs", "params": { "urls": ["*analytics*"] } } }
  ]
}
```

The [protocol reference](https://chromedevtools.github.io/devtools-protocol/) lists every command. To listen for protocol events, use `playwright` with Playwright's own [CDP session](https://playwright.dev/docs/api/class-cdpsession).

## electron: the app's main process

An Electron app runs its windows' pages in Chromium, and everything else in its main process: the windows themselves, menus, native dialogs, IPC, the file system. `electron` runs JavaScript there. It needs a session [attached](sessions.md#running-browsers-and-electron-apps) to the app with `inspect` as well: the port the app's `--inspect` flag gives its Node debugger.

```sh
/Applications/MyApp.app/Contents/MacOS/MyApp --remote-debugging-port=9222 --inspect=9229
```

`new`

```json
{ "name": "app", "attach": 9222, "inspect": 9229 }
```

The code is statements, and the value of the last one is handed back, with no `return`, and awaited when it is a promise; `await` works anywhere in it. `electron` is the electron module, and `app`, `BrowserWindow`, `webContents`, `ipcMain`, `dialog`, `Menu`, `shell`, `session`, `clipboard`, `nativeTheme` and `screen` are its parts by name. `require` works too, and so does [`stub`](#stubs). What the code declares with `const`, `let` and `class` stays in it, and may reuse those names; `var` and `function` declarations become the app's globals, as in any script. A longer script can live in a file: `{ "electron": { "file": "seed.js" } }`.

`run`

```json
{
  "session": "app",
  "steps": [
    { "electron": "app.getName()" },
    { "electron": "BrowserWindow.getAllWindows().map((window) => window.getTitle())" },
    { "electron": "stub(dialog, 'showOpenDialog', async () => ({ canceled: false, filePaths: ['/tmp/fixture.txt'] }))" },
    { "click": "text=Open file" },
    { "expect": { "electron": "BrowserWindow.getAllWindows().length === 2" } },
    { "electron": "Menu.getApplicationMenu().items.map((item) => item.label)" },
    { "electron": "BrowserWindow.getAllWindows()[0].setBounds({ width: 800, height: 600 })" }
  ]
}
```

Data comes back as it is, and anything that isn't data as what it is, however deep: `[BrowserWindow]`, `[Function save]`, `[Circular]`. `NaN`, `Infinity` and BigInts come back as text, a date as its ISO string, a set as a list, and a map as an object when its keys are strings. Code that doesn't compile is refused, in the app's own words; an error it throws as it runs fails the step with its message.

What the main process logs goes to the session's console log, and so to the reply, as `[main console.log] ...`, much as Node's console prints it, one level deep. It counts as the page's does: `ignore` applies to it, `{ "expect": { "console": ... } }` waits for it, and a `console.error` fails `noErrors`, which is where an IPC handler that throws shows. Every session joined to one app sees all of what its main process logs.

`{ "expect": { "electron": "code" } }` waits until code in the main process is truthy, as `{ "expect": { "js": ... } }` does in the page.

In `playwright` code, `electron(fn, arg)` runs a function there instead. It is sent as its source, so it can't use variables from around it; pass what it needs as `arg`, which goes as JSON.

Some things worth knowing about Electron itself:

- An IPC handler isn't a property, so `stub` can't stand in for it. Replacing one takes `ipcMain.removeHandler("channel")`, then `ipcMain.handle("channel", ...)`, and it stays replaced after the session. To call or restore the original, keep it first: Electron keeps handlers in `ipcMain._invokeHandlers`, a map that is its own and not promised to stay.
- A menu item clicked from code (`Menu.getApplicationMenu().getMenuItemById("open").click()`) gets no window unless given one. An app that acts on the focused window wants `item.click({}, window, window.webContents)`.
- Node's own debugger is open to the code too, for what the protocol has and Electron doesn't: `new (require("inspector").Session)()` can profile the main process or take a heap snapshot.

What joining the main process means:

- **It changes the real app, and the machine.** What `stub` replaced is put back when the session ends; anything else the code changes stays until the app restarts. `clipboard.writeText` writes the system's clipboard, and `shell.openExternal` opens a real browser.
- **The app waits while the code runs.** Its windows can't respond until the main process is free again. Code that is still busy at the step's timeout is stopped, before an `await` or after one, and the app goes on. Code that is only waiting, on a promise that hasn't settled, is no longer waited for, but may still settle in the app.
- **The debugger port is open to anything on the machine** for as long as the app runs, and anything that reaches it can run code as the app. Turn it on only while testing, on a port you choose. weblab never turns it on itself.
- **Not every app can be joined.** An app packaged with its `EnableNodeCliInspectArguments` [fuse](https://www.electronjs.org/docs/latest/tutorial/fuses) turned off ignores `--inspect`. Its windows can still be attached; a dev build has it on.
- **Quitting and restarting aren't held up.** An app that exits while a session is joined to it lets go of the session, so a dev tool's restart goes ahead. The next step on that session says the app went away; end it, and open a new one on the app that came back.
- **Both ports have to be the same app's.** An app's windows and its main process are one process, so `new` refuses an `attach` and an `inspect` that belong to two.

### Stubs

`stub(object, name, replacement)` puts the replacement in place of `object[name]` for the rest of the session, and puts the original back when the session ends, so an app that was attached is left as it was found. It is how a native dialog, a link that would open a browser, or a request that would leave the machine is answered:

`run`

```json
{
  "session": "app",
  "steps": [
    { "electron": "stub(dialog, 'showMessageBox', async (window, options) => { console.log('asked:', options.message); return { response: 1 }; })" },
    { "click": "text=Delete" },
    { "expect": { "console": "asked: Delete everything?" } },
    { "electron": "stub(shell, 'openExternal', async (url) => console.log('would open', url))" },
    { "electron": "const real = globalThis.fetch; stub(globalThis, 'fetch', async (url, init) => String(url).includes('/catalog') ? Response.json({ items: [] }) : real(url, init))" }
  ]
}
```

A replacement that wants the original keeps it first, as the `fetch` one does. Logging from it is how a check sees that it was called. A property that can't be replaced (read-only, or a getter, as the electron module's own parts are: stub `dialog.showOpenDialog`, not `electron.dialog`) is refused. When the session ends, the property is as it was, even one that came from a prototype; one something else has replaced in the meantime is left as that has it.

## Code files

A step file can be code: a `.ts`, `.mts`, `.js` or `.mjs` file whose default export is called with the same names `playwright` gets. Run it with `run`'s `file`, or as a step: `{ "playwright": { "file": "/tmp/pages.ts" } }`.

`/tmp/pages.ts`:

```ts
export default async ({ page, step }) => {
  const wide = [];
  for (const path of ["/", "/pricing", "/about", "/blog"]) {
    await step({ goto: path });
    await step({ expect: { noErrors: true } });
    await step({ shot: path === "/" ? "home" : path.slice(1) });
    // This function runs in the page; the rest of the file runs in weblab.
    const width = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (width > 0) wide.push(`${path} scrolls sideways by ${width}px`);
  }
  if (wide.length > 0) throw new Error(wide.join("; "));
  return { checked: 4 };
};
```

`run`

```json
{ "file": "/tmp/pages.ts" }
```

```text
ok    1 playwright (3120ms)
{
  "checked": 4
}
shot  $TMPDIR/weblab/shop-20261003-101600/shots/main-home.png
shot  $TMPDIR/weblab/shop-20261003-101600/shots/main-pricing.png
shot  $TMPDIR/weblab/shop-20261003-101600/shots/main-about.png
shot  $TMPDIR/weblab/shop-20261003-101600/shots/main-blog.png
url   http://localhost:5173/blog
title Blog
```

Loops, conditions, helper functions and data belong here. A code file can import modules of its own by a path relative to itself, and TypeScript runs as it is, with no build step.

- **What it returns** is the step's value, printed as JSON in the reply. To see something, return it: what the code prints with `console.log` goes to weblab's stderr, not into the reply.
- **The steps it runs** are listed under it in the reply, numbered within it (`1.1`, `1.2`), each with its outcome, what it handed back, and any screenshot it took.
- **An edited file** runs as it now is, each time. A module it imports is loaded once per weblab process, so an edit there needs weblab to start again.
- **Relative paths** in its steps are read from the file's directory first, when it is run with `run`'s `file`.

### Catching failures

`step()` throws when the step fails, and the code step fails with it, unless the code catches it:

```ts
export default async ({ step, params }) => {
  await step({ goto: "/" });
  try {
    await step({ expect: "Welcome back", timeout: 2000 });
  } catch {
    // Not signed in: sign in, then go on.
    await step({ goto: "/login" });
    await step({ fill: { label: "Email", value: params.email } });
    await step({ fill: { label: "Password", value: params.password } });
    await step({ click: { role: "button", name: "Sign in" } });
  }
  await step({ expect: "Welcome back", message: "still not signed in" });
};
```

A failure the code catches leaves the run passing; the reply still shows that step as `FAIL` under the code step. `include` belongs to JSON steps; in code, call `step()` for each step, or loop over a list. Steps can run side by side, `await Promise.all([step({ js: "1" }), step({ js: "2" })])`; on one session they share its timeout.

### Where errors point

A failure in code says where it came from:

| What happened | The reply says |
| --- | --- |
| A step the code ran failed, and the code let it through | `FAIL  1 playwright: its step 2 (expect): the greeting is missing (expected the text "Hello" to be visible)`: which of its steps, that step's `message`, and what happened. The screenshot is of the page at that moment, `shots/main-FAIL-1.2-expect.png`. |
| The code threw its own error | `FAIL  1 playwright: thrown by the code (check.ts:4)`: the message, and the file and line it came from. |
| A step the code ran is written wrong | `FAIL  1 playwright: its step 2 (clik): unknown step {"clik":"#inc"} (did you mean "click"?); every step is listed in the run tool's description` |

The line number is given for code files, not for code written inline in a step.

## Another session

Some things take two: a message one user sends and another reads, an invite, two devices syncing. In code, `newSession()` opens another session, as the `new` step does, and hands it back, so its steps don't have to say `on`:

`/tmp/chat.ts`:

```ts
export default async ({ step, newSession }) => {
  await step({ goto: "/room/1" });
  const guest = await newSession({ name: "guest", path: "/room/1" }); // a browser of its own: no shared cookies
  await step({ fill: { label: "Message", value: "hello" } });
  await step({ press: "Enter" });
  await guest.step({ expect: "hello" }); // the same as step({ expect: "hello", on: "guest" })
  await guest.step({ shot: "received" });
  const seen = await guest.page.title();
  await guest.end();
  return seen;
};
```

`newSession()` takes what the `new` tool takes, and what it doesn't say is as the session the code runs on, as for the [`new` step](sessions.md#a-new-step-and-what-it-inherits): `newSession({ name: "b", attach: 9242 })` is another running browser or Electron app. What it hands back has `name`, `page`, `context`, `origin`, `logs`, `responses`, `locate`, `cdp`, `step` and `end()`. A session opened in code stays open after the code ends, until something ends it.

## One file, several setups

How a session is driven (its viewport, its context options, its browser) is set when it is opened, not in the file. To run one file as a phone and as a desktop, open a session for each and run the file on both:

`new`

```json
{ "name": "phone", "viewport": "390x844@3", "context": { "isMobile": true, "hasTouch": true } }
```

`new`

```json
{ "name": "desktop" }
```

`run`

```json
{ "session": "phone", "file": "/tmp/pages.ts" }
```

`run`

```json
{ "session": "desktop", "file": "/tmp/pages.ts" }
```

Each session's screenshots are named after it: `shots/phone-home.png`, `shots/desktop-home.png`.

# Code

This page covers the five steps that run code, and step files written as code. The named steps cover what is done all the time: go somewhere, click, fill, check, take a screenshot. Code covers everything else: anything a browser can do, weblab can do with code. Reach for it whenever no named step fits; there is no need to bend a step into shape.

| Step | Runs | Good for |
| --- | --- | --- |
| `js` | JavaScript inside the page, as the page's own code would | Reading the app's state, calling its APIs, setting storage, measuring layout |
| `css` | A stylesheet added to the page | Hiding toasts, dev toolbars and whatever changes from run to run, before a screenshot |
| `playwright` | [Playwright](https://playwright.dev/docs/api/class-page) code driving the page from outside | Anything the named steps don't do: precise mouse paths, the clock, downloads, popups, permissions, PDFs |
| `cdp` | One raw [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) command | What even Playwright doesn't offer: network and CPU throttling, performance metrics, vision deficiencies |
| `electron` | JavaScript in an attached Electron app's main process | What the app's pages can't reach: native dialogs, menus, the windows themselves, IPC |

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

An Electron app runs each window's page in Chromium, and everything else in its main process: the windows themselves, menus, native dialogs, IPC and the file system. `electron` runs JavaScript in the main process. The session has to be [attached](sessions.md#running-browsers-and-electron-apps) to the app and opened with `inspect`, the port of the Node debugger the app starts with `--inspect`.

```sh
/Applications/MyApp.app/Contents/MacOS/MyApp --remote-debugging-port=9222 --inspect=9229
```

`new`

```json
{ "name": "app", "attach": 9222, "inspect": 9229 }
```

The code can be several statements, and the step hands back the value of the last one, with no `return`. If that value is a promise, it is awaited, and `await` works anywhere in the code. The electron module is there as `electron`, and its common parts by name: `app`, `BrowserWindow`, `webContents`, `ipcMain`, `dialog`, `Menu`, `shell`, `session`, `clipboard`, `nativeTheme` and `screen`. `require` and [`stub`](#stub-standing-in-for-a-method) work too. A longer script can live in a file: `{ "electron": { "file": "seed.js" } }`.

Variables declared with `const`, `let` or `class` stay inside the step, so they never clash with the app's own. `var` and `function` declarations become globals of the app, as in any script.

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

Values come back as JSON. What isn't plain data comes back as a short label instead: a window as `[BrowserWindow]`, a function as `[Function save]`, and a reference back to an object already shown as `[Circular]`. `NaN`, `Infinity` and BigInts come back as text, dates as ISO strings and sets as lists. A map comes back as an object when its keys are strings, and as a list of `[key, value]` pairs otherwise.

Code with a syntax error is refused, with the app's own error message. Code that throws while it runs fails the step with the error.

What the main process logs goes to the session's console log and the reply, marked `[main console.log] ...`. Objects in it are shown as Chrome's DevTools console shows them, one level deep. These lines count the same as the page's: `ignore` filters them, `{ "expect": { "console": ... } }` can wait for one, and a `console.error` fails `noErrors`. That is usually where an IPC handler that throws shows up. Node's own warnings, such as a deprecated API, count as warnings. As with the page's lines, checks only look at what was logged since the page last loaded, so a reload starts them afresh. Every session joined to the same app sees everything its main process logs.

`{ "expect": { "electron": "code" } }` waits until the code is truthy in the main process, as `{ "expect": { "js": ... } }` does in the page.

In `playwright` code, `electron(fn, arg)` runs a function in the main process, called with the electron module and `arg`: `await electron(({ app }, name) => app.setName(name), "Test")`. The function is sent as source text, so it can't use variables from the code around it. Pass what it needs as `arg`, which is sent as JSON.

A few things about Electron itself are worth knowing:

- IPC handlers aren't properties, so `stub` can't replace them. Replacing one takes `ipcMain.removeHandler("channel")` and then `ipcMain.handle("channel", ...)`, and the new handler stays after the session ends. To call or restore the original, keep it first. Electron holds handlers in `ipcMain._invokeHandlers`, an internal map that may change in a future version.
- A menu item clicked from code (`Menu.getApplicationMenu().getMenuItemById("open").click()`) gets no window unless one is passed. If the app acts on the focused window, use `item.click({}, window, window.webContents)`.
- Node's own inspector is open to the code too, for what Electron doesn't offer: `new (require("inspector").Session)()` can profile the main process or take a heap snapshot.

Before using it:

- **It changes the real app, and the machine.** Stubs are put back when the session ends, but anything else the code changes stays until the app restarts. `clipboard.writeText` writes the system clipboard, and `shell.openExternal` opens a real browser.
- **The app freezes while the code runs.** Its windows can't respond until the main process is free. Code that is still busy when the step times out is stopped, whether or not it awaited something first, and the app carries on. Code that is only waiting on a promise isn't stopped. The step stops waiting for it, but the promise may still settle later in the app.
- **The debugger port is open to anything on the machine** while the app runs, and anything that connects to it can run code as the app. Turn it on only while testing, on a port of your own choosing. weblab never turns it on itself.
- **Not every app can be joined.** An app packaged with the `EnableNodeCliInspectArguments` [fuse](https://www.electronjs.org/docs/latest/tutorial/fuses) turned off ignores `--inspect`. Its windows can still be attached. Dev builds normally have the fuse on.
- **Quitting and restarting aren't blocked.** If the app exits while a session is joined to it, weblab lets go at once, so a dev tool's restart goes through. The next step on that session says the app went away, and `list` marks it as gone. End the session and open a new one on the restarted app. If weblab started the app, ending its last session stops the restarted app too, so open the new session first.
- **Both ports must belong to the same app.** An app's main process is also the browser process behind its windows, so `new` refuses an `attach` and an `inspect` that point at two different apps.

### stub: standing in for a method

`stub(object, name, replacement)` replaces `object[name]` for the rest of the session. When the session ends, the original is put back, so an attached app is left the way it was found. It is how a test answers a native dialog, catches a link that would open a browser, or serves a request that would otherwise leave the machine:

`run`

```json
{
  "session": "app",
  "steps": [
    { "electron": "stub(dialog, 'showMessageBox', async (...args) => { console.log('asked:', args.at(-1).message); return { response: 1 }; })" },
    { "click": "text=Delete" },
    { "expect": { "console": "asked: Delete everything?" } },
    { "electron": "stub(shell, 'openExternal', async (url) => console.log('would open', url))" },
    { "electron": "const real = globalThis.fetch; stub(globalThis, 'fetch', async (url, init) => String(url).includes('/catalog') ? Response.json({ items: [] }) : real(url, init))" }
  ]
}
```

Electron's dialog functions take a window as their first argument only when the app passes one, so a replacement that needs the options reads the last argument, `args.at(-1)`. A replacement that calls the original saves it first, as the `fetch` one does. Logging from a replacement is how a check can tell it was called.

`stub` refuses what it couldn't put back as it was: a name the object doesn't have (usually a typo), a read-only property, or a getter or setter. The electron module's own parts are getters, so stub `dialog.showOpenDialog`, not `electron.dialog`. A setting such as `nativeTheme.themeSource` is a setter, so it is set directly instead, and stays set after the session. When the session ends, each stubbed property goes back to exactly how it was, even one inherited from a prototype. A property something else has replaced in the meantime is left alone.

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

`newSession()` takes what the `new` tool takes, and what it doesn't say is as the session the code runs on, as for the [`new` step](sessions.md#a-new-step-and-what-it-inherits): `newSession({ name: "b", attach: 9242 })` is another running browser or Electron app. What it hands back has `name`, `page`, `context`, `origin`, `logs`, `responses`, `locate`, `cdp`, `electron`, `step` and `end()`. A session opened in code stays open after the code ends, until something ends it.

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

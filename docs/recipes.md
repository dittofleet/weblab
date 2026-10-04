# Recipes

Short answers to common tasks, each shown as the arguments to pass to `run` (and to `new` where it matters). They assume a session is open; `new` with no arguments opens one named `main` at the project's dev server. Files written for a task can live anywhere; `/tmp` keeps them out of the repository.

Many recipes use the [code steps](code.md). That is deliberate: when no named step fits, code is the direct route, not a last resort.

- [See what a page looks like right now](#see-what-a-page-looks-like-right-now)
- [Find out why something failed](#find-out-why-something-failed)
- [Make screenshots steady](#make-screenshots-steady)
- [Show a state without the backend](#show-a-state-without-the-backend)
- [Try dark mode, a phone, or another language](#try-dark-mode-a-phone-or-another-language)
- [Start signed in](#start-signed-in)
- [Check that nothing errored, and that the app called its API](#check-that-nothing-errored-and-that-the-app-called-its-api)
- [Check every page's health](#check-every-pages-health)
- [Fake a microphone or camera](#fake-a-microphone-or-camera)
- [Fake a WebSocket server](#fake-a-websocket-server)
- [Work with a canvas](#work-with-a-canvas)
- [Double-click, right-click, hold a key](#double-click-right-click-hold-a-key)
- [Control time](#control-time)
- [Simulate a slow or offline network](#simulate-a-slow-or-offline-network)
- [Capture native menus](#capture-native-menus)
- [Screenshot many pages](#screenshot-many-pages)
- [Compare before and after a change](#compare-before-and-after-a-change)
- [Record a demo video](#record-a-demo-video)
- [Upload and download files](#upload-and-download-files)
- [Popups and new tabs](#popups-and-new-tabs)
- [Use a server you started yourself](#use-a-server-you-started-yourself)
- [Drive an Electron app](#drive-an-electron-app)
- [Test two users or two devices at once](#test-two-users-or-two-devices-at-once)
- [Ask a running app one thing](#ask-a-running-app-one-thing)
- [Run something long](#run-something-long)

## See what a page looks like right now

`run`

```json
{ "steps": [{ "goto": "/pricing" }, { "look": true }, { "shot": { "as": "pricing", "fullPage": true } }] }
```

`look` hands back the accessibility tree, with refs to act on; `{ "look": { "format": "text" } }` gives just the words, and `{ "look": { "selector": "main" } }` one element. The screenshot comes back as an image.

## Find out why something failed

A failed step's reply has the reason, a screenshot of the page at that moment, and what the console logged:

```text
FAIL  4 click: Timeout 10000ms exceeded waiting for getByRole('button', { name: 'Pay' })
shot  $TMPDIR/weblab/shop-20261003-101600/shots/main-FAIL-4-click.png

console since the last reply:
  [console.error] cart total missing (http://localhost:5173/src/cart.ts)
```

Look at the screenshot first. The session is still open, at the page as it was, so read it with `{ "look": true }` and try the next step by hand. Then:

- `console/<session>.log` in the session's files directory has each step as it ran, the page's console output, page errors, dialogs and failed requests.
- `network/<session>.log` has every response: status, method and URL, with `(mocked)` on those a `mock` answered.
- A session opened with `"trace": "on-failure"` keeps `traces/<session>.zip` when a step fails, written when the session ends: a screenshot, the DOM and the network for every action. Open it at [trace.playwright.dev](https://trace.playwright.dev), which reads the file in the browser without uploading it.

## Make screenshots steady

A `shot` already finishes CSS animations and transitions for the moment it captures. What is left is what the app puts on screen by itself: toasts, dev toolbars, timestamps, avatars. Hide them with a stylesheet, which stays through reloads:

`run`

```json
{
  "steps": [
    { "css": "[data-sonner-toaster], .toast, astro-dev-toolbar, vite-error-overlay { display: none !important }" },
    { "css": ".avatar img, time { visibility: hidden }" },
    { "expect": "Saved" },
    { "shot": "settled" }
  ]
}
```

Wait for what the app shows or reports rather than a guessed time: `{ "expect": "Saved" }`, `{ "expect": { "js": "window.app.ready" } }`. Animations driven by JavaScript (a canvas, a spring) aren't CSS animations; give them `{ "wait": 500 }`, or [fix the clock](#control-time).

## Show a state without the backend

Some states are hard to reach for real: an empty list, an error, a thousand items.

**URL options.** If the app reads its state from the query string, go there: `{ "goto": "/devices?peers=offline" }`.

**Fake API responses.** `mock` answers matching requests with whatever it is given. Set it up before the `goto` or `reload` it should affect:

`run`

```json
{
  "steps": [
    { "mock": { "url": "**/api/orders", "json": [] } },
    { "goto": "/orders" },
    { "expect": "No orders yet" },
    { "shot": "empty" },
    { "mock": { "url": "**/api/orders", "status": 500, "body": "boom" } },
    { "reload": true },
    { "shot": "error" },
    { "mock": { "url": "**/api/orders", "off": true } }
  ]
}
```

Requests a mock answered are marked `(mocked)` in the network log, so a glob that never matched is easy to spot.

**Storage.** For state the app keeps in the browser, set it, then reload:

`run`

```json
{ "steps": [{ "js": "localStorage.setItem('onboarded', '1')" }, { "reload": true }] }
```

**Code that runs before the app's own.** For a fake backend on `window`, a feature flag, or a stubbed API:

`run`

```json
{ "steps": [{ "playwright": "await context.addInitScript(() => { window.FEATURE_FLAGS = { newCheckout: true } })" }, { "reload": true }] }
```

## Try dark mode, a phone, or another language

On an open session, with no reload:

`run`

```json
{ "steps": [{ "colorScheme": "dark" }, { "viewport": "390x844" }, { "shot": "dark-narrow" }] }
```

Everything else is set when a session opens. Open one per setup, beside the first:

`new`

```json
{ "name": "phone", "viewport": "390x844@3", "context": { "isMobile": true, "hasTouch": true } }
```

`new`

```json
{ "name": "german", "context": { "locale": "de-DE", "timezoneId": "Europe/Berlin", "colorScheme": "dark" } }
```

`context` takes any of Playwright's [browser context options](https://playwright.dev/docs/api/class-browser#browser-new-context). Reduced motion is code: `{ "playwright": "await page.emulateMedia({ reducedMotion: 'reduce' })" }`.

## Start signed in

Sign in once and save it:

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

Then open any later session from it:

`new`

```json
{ "name": "ada", "state": "ada", "path": "/account" }
```

[Sessions](sessions.md#saved-sign-ins) covers the other ways: keeping a whole profile with `persist`, or attaching to a browser that is already signed in.

## Check that nothing errored, and that the app called its API

`run`

```json
{
  "steps": [
    { "click": { "role": "button", "name": "Save" } },
    { "expect": { "request": "**/api/settings", "status": 200 } },
    { "expect": { "noErrors": true } }
  ]
}
```

The session's `ignore` keeps known noise out of the logs and out of `noErrors`. Checks of the console and of requests look at what happened since the page last loaded.

To check that one click made one request, rather than that the request happened at some point, wait for both together in code:

`run`

```json
{ "steps": [{ "playwright": "const [response] = await Promise.all([page.waitForResponse('**/api/settings'), locate({ role: 'button', name: 'Save' }).click()]); return { status: response.status(), sent: response.request().postDataJSON() }" }] }
```

## Check every page's health

A code file can walk the site, check what matters on each page, and hand back what it found:

`/tmp/health.ts`:

```ts
export default async ({ page, step }) => {
  const problems = [];
  await step({ goto: "/" });
  const paths = await page.evaluate(() => [...new Set([...document.querySelectorAll("a[href^='/']")].map((a) => a.getAttribute("href")))]);
  for (const path of paths) {
    const response = await page.request.get(new URL(path, page.url()).href);
    if (response.status() >= 400) { problems.push(`${path}: ${response.status()}`); continue; }
    await step({ goto: path });
    await step({ expect: { noErrors: true }, message: `${path} logged errors` });
    const found = await page.evaluate(() => ({
      sideways: document.documentElement.scrollWidth - innerWidth,
      noAlt: [...document.images].filter((image) => !image.hasAttribute("alt")).length,
      headings: [...document.querySelectorAll("h1, h2, h3, h4")].map((heading) => Number(heading.tagName[1])),
    }));
    if (found.sideways > 0) problems.push(`${path}: scrolls sideways by ${found.sideways}px`);
    if (found.noAlt > 0) problems.push(`${path}: ${found.noAlt} images without alt text`);
    if (found.headings.some((level, index) => index > 0 && level > found.headings[index - 1] + 1)) problems.push(`${path}: skips a heading level`);
  }
  return problems;
};
```

`run`

```json
{ "file": "/tmp/health.ts" }
```

## Fake a microphone or camera

Chromium can stand in a fake device, and play a file as the microphone. Give it the flags when the session opens, then grant the permission:

`new`

```json
{
  "name": "mic",
  "browserArgs": ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-audio-capture=/tmp/speech.wav"]
}
```

`run`

```json
{ "session": "mic", "steps": [{ "playwright": "await context.grantPermissions(['microphone', 'camera'], { origin })" }, { "reload": true }] }
```

A WAV file can be made on the spot, for example with `say -o /tmp/speech.wav --data-format=LEI16@16000 "Hello"` on a Mac. Without the file, the fake microphone plays a beep.

For full control, replace `getUserMedia` before the app loads:

`run`

```json
{ "steps": [{ "playwright": "await context.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { const audio = new AudioContext(); const tone = audio.createOscillator(); const out = audio.createMediaStreamDestination(); tone.connect(out); tone.start(); return out.stream; }; })" }, { "reload": true }] }
```

## Fake a WebSocket server

`mock` answers HTTP requests. For a WebSocket, route it in code and answer each message the app sends:

`run`

```json
{ "steps": [{ "playwright": "await page.routeWebSocket('wss://api.example.com/live**', (socket) => socket.onMessage((message) => { const event = JSON.parse(String(message)); if (event.type === 'ping') socket.send(JSON.stringify({ type: 'pong' })); }))" }, { "reload": true }] }
```

The network log notes every WebSocket the page opens and closes over the network; a routed one never reaches the network, so it isn't there. To see what went over a routed socket, keep a record in the handler (`ctx.sent ??= []; ctx.sent.push(String(message))`) and read it back with `{ "playwright": "return ctx.sent" }`.

## Work with a canvas

A canvas has no elements inside it to name, so `click`, `hover` and `drag` take points as well, in pixels from the top left of the page:

`run`

```json
{
  "steps": [
    { "click": { "x": 400, "y": 300 } },
    { "drag": { "from": { "x": 300, "y": 300 }, "to": { "x": 500, "y": 300 } } },
    { "playwright": "await page.mouse.move(400, 300); await page.mouse.wheel(0, -500)" },
    { "playwright": "const box = await locate('canvas').boundingBox(); await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2)" }
  ]
}
```

Check what the canvas did through what the app shows or reports: a readout on the page, or its state through `js`.

## Double-click, right-click, hold a key

`run`

```json
{
  "steps": [
    { "click": { "target": "e12", "count": 2 } },
    { "click": { "target": "e12", "button": "right" } },
    { "click": { "target": "e12", "modifiers": ["Shift"] } },
    { "playwright": "await page.keyboard.down('Alt'); await page.mouse.wheel(0, 200); await page.keyboard.up('Alt')" }
  ]
}
```

## Control time

`run`

```json
{
  "steps": [
    { "playwright": "await page.clock.setFixedTime(new Date('2026-12-24T09:00:00'))" },
    { "reload": true },
    { "playwright": "await page.clock.install(); await page.clock.fastForward('10:00')" }
  ]
}
```

## Simulate a slow or offline network

`run`

```json
{
  "steps": [
    { "cdp": "Network.enable" },
    { "cdp": { "method": "Network.emulateNetworkConditions", "params": { "offline": false, "latency": 600, "downloadThroughput": 40000, "uploadThroughput": 20000 } } },
    { "cdp": { "method": "Emulation.setCPUThrottlingRate", "params": { "rate": 4 } } },
    { "playwright": "await context.setOffline(true)" }
  ]
}
```

The CDP settings last for the rest of the session, in that tab. `cdp` works in Chromium browsers only.

## Capture native menus

An open `<select>`, a context menu and a date picker are drawn by the operating system, not the page, so an ordinary `shot` leaves them out. A session with a window can capture the real screen, menus included ([Steps](steps.md#the-real-screen) has what it needs):

`new`

```json
{ "name": "screen", "headed": true, "viewport": "1200x800", "path": "/settings" }
```

`run`

```json
{ "session": "screen", "steps": [{ "click": { "label": "Size" } }, { "shot": { "as": "size-menu", "screen": true } }, { "js": "document.activeElement.blur()" }] }
```

Open the menu and capture it in the same `run`. The `blur` closes it: the menu is the OS's, so a key press from weblab doesn't reach it. To choose from a native dropdown, use `select`, which sets the value without the menu. `"screen": "window"` includes the browser's toolbar; `"screen": "display"` captures the whole display.

When the picture doesn't have to be of the OS's own menu, Chrome can draw the dropdown in the page, where an ordinary `shot` sees it, headless included: `{ "css": "select, ::picker(select) { appearance: base-select }" }`.

## Screenshot many pages

`run`

```json
{
  "steps": [
    { "goto": "/" }, { "shot": "home" },
    { "goto": "/pricing" }, { "shot": "pricing" },
    { "goto": "/about" }, { "shot": "about" }
  ]
}
```

Or loop over them in a [code file](code.md#code-files). For many pages, keep the reply small: screenshots past six in one reply are named by path only, and the files are all in `shots/`.

## Compare before and after a change

Take a shot, make the change (a dev server reloads the page by itself), and hold a new shot to the first with `matches`. The step fails if they differ, and keeps a picture with what differs in red:

`run`

```json
{ "steps": [{ "goto": "/" }, { "shot": "before" }] }
```

`run`

```json
{ "steps": [{ "goto": "/" }, { "shot": { "as": "after", "matches": "/tmp/weblab-out/shots/main-before.png" } }] }
```

The path is the one the first reply's `shot` line gave; here the session was opened with `"out": "/tmp/weblab-out"`. To compare two checkouts side by side, open a session in each, at addresses of their own:

`new`

```json
{ "name": "before", "dir": "../shop", "address": 4201, "start": "pnpm dev --port 4201", "out": "/tmp/compare" }
```

`new`

```json
{ "name": "after", "dir": "../shop-feature", "address": 4202, "start": "pnpm dev --port 4202", "out": "/tmp/compare" }
```

`run`

```json
{
  "session": "before",
  "steps": [
    { "goto": "/" },
    { "shot": "home" },
    { "goto": "/", "on": "after" },
    { "shot": { "as": "home", "matches": "/tmp/compare/shots/before-home.png" }, "on": "after" }
  ]
}
```

To compare a page's content rather than its pixels, keep a named `look` in each (`{ "look": "home" }`) and diff the two `looks/*.yml` files.

## Record a demo video

Open a session at the size the video should be, set up whatever comes before the part worth showing, then record that part:

`new`

```json
{ "name": "demo", "viewport": "1280x800@2" }
```

`run`

```json
{ "session": "demo", "steps": [{ "goto": "/settings" }, { "video": { "as": "dark-mode" } }, { "click": { "label": "Dark mode" } }, { "expect": "Saved" }, { "video": "stop" }] }
```

```text
...
ok    5 video (2102ms)
file  $TMPDIR/weblab/shop-20261003-101600/videos/demo-dark-mode.webm
```

The video starts once the app is ready, never on a page still loading. A headless browser has no pointer of its own, so while recording weblab draws a cursor that glides to each click, types at a readable pace, and pauses after each action so the video can be followed. Steps before `start` run at full speed. With `FFMPEG` set to an ffmpeg binary, an `.mp4` lands beside the `.webm`. A session attached to a running browser or app records the tab it drives the same way. [Steps](steps.md#recording-a-video) has the rest.

## Upload and download files

`run`

```json
{ "steps": [{ "upload": { "selector": "input[type=file]", "file": "/tmp/photo.png" } }] }
```

The input can be hidden; no file picker opens. A target that isn't an input, such as a "Choose file" button or a drop zone, is clicked, and the picker it opens is answered. A test file can be made on the spot by any program before the upload.

Downloads are code. Save the file into the session's files directory, and `ctx.artifacts.addFile` lists it in the reply:

`run`

```json
{ "steps": [{ "playwright": "const [file] = await Promise.all([page.waitForEvent('download'), locate('text=Export').click()]); const path = ctx.artifacts.dir + '/downloads/' + file.suggestedFilename(); await file.saveAs(path); ctx.artifacts.addFile(path); return file.suggestedFilename()" }] }
```

## Popups and new tabs

`run`

```json
{
  "steps": [
    { "click": { "role": "link", "name": "Open in new tab" } },
    { "tab": "new" },
    { "expect": { "url": "/report" } },
    { "tab": 0 }
  ]
}
```

`"new"` waits for a tab the steps haven't been on yet. The reply lists the tabs while there is more than one.

## Use a server you started yourself

If the app is already running, give its address; weblab uses it as it is and leaves it running:

`new`

```json
{ "address": 3000 }
```

To have weblab start it some other way than the `dev` script, give the command, the address it answers at, and, if need be, what ready means and how long it may take:

`new`

```json
{ "address": 4173, "start": "pnpm preview --port 4173", "ready": { "selector": "#root > *" }, "startTimeout": 120000 }
```

[Tools](tools.md#how-an-address-is-resolved) has the details.

## Drive an Electron app

Start the app with a debugging port, then attach:

```sh
/Applications/MyApp.app/Contents/MacOS/MyApp --remote-debugging-port=9222 &
```

`new`

```json
{ "name": "app", "attach": 9222 }
```

`run`

```json
{ "session": "app", "steps": [{ "look": true }, { "js": "window.api.status()" }] }
```

An app just started may still be loading, a fresh dev build especially. `{ "ready": true }` waits for it to show something, and `{ "video": "start" }` waits the same way before it records.

An attached app has a real window, so `{ "shot": { "as": "menu", "screen": true } }` captures its native menus too. Ending the session lets go of the app, which keeps running. [Sessions](sessions.md#running-browsers-and-electron-apps) covers starting apps with a port, picking a window, and what is different when attached.

## Test two users or two devices at once

`run`

```json
{
  "steps": [
    { "goto": "/room/1" },
    { "new": { "name": "guest", "path": "/room/1" } },
    { "fill": { "label": "Message", "value": "hello" } },
    { "press": "Enter" },
    { "expect": "hello", "on": "guest" }
  ]
}
```

`guest` is a browser of its own, sharing no cookies with `main`. Two windows of a desktop app are two sessions, each attached by its own port: `{ "new": { "name": "b", "attach": 9242 } }`. [Sessions](sessions.md) has every option.

## Ask a running app one thing

`new`

```json
{ "name": "peek", "attach": 9222 }
```

`run`

```json
{ "session": "peek", "steps": [{ "expect": { "js": "window.api.ready" } }, { "js": "window.api.hub.status()" }, { "shot": "now" }] }
```

`end`

```json
{ "session": "peek" }
```

## Run something long

A `run` replies within `wait` milliseconds (45 seconds by default), with the steps still running if they take longer. Ask for the rest with no steps:

`run`

```json
{ "session": "main" }
```

Give a longer `wait` when the client allows long tool calls, or a shorter one to check on progress: `{ "steps": [...], "wait": 10000 }`. See [Tools](tools.md#runs-that-outlast-the-call).

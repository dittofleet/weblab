# Steps

This is the reference for every step `run` takes: what each does, its forms and options, how steps name elements, and how steps are reused with `include` and placeholders. The `run` tool's own description lists the same steps in one line each.

Most steps are shortcuts for what is done all the time. Five of them run code (`js`, `css`, `playwright`, `cdp`, and `electron` in an Electron app's main process), and with those anything a browser can do is in reach. [Code](code.md) covers them. In a React app, `react` reads and changes its components the way React DevTools does.

| Group | Steps |
| --- | --- |
| [Getting around](#getting-around) | `goto`, `reload`, `ready`, `back`, `tab`, `viewport`, `colorScheme` |
| [Pointer and keyboard](#pointer-and-keyboard) | `click`, `hover`, `drag`, `scroll`, `press`, `type` |
| [Forms](#forms) | `fill`, `select`, `check`, `upload` |
| [Checking](#checking) | `wait`, `expect` |
| [Reading and capturing](#reading-and-capturing) | `look`, `shot`, `video` |
| [Around the page](#around-the-page) | `dialog`, `mock`, `saveState` |
| [Code](#code) | `js`, `css`, `playwright`, `cdp` |
| [React](#react) | `react` |
| [More than one session](#more-than-one-session) | `new`, `end` |
| [Reusing steps](#reusing-steps) | `include` |

## How a step is written

A step is an object with one action. Most actions take a bare value, or an object holding the same value under a key, plus options:

`run`

```json
{
  "steps": [
    { "click": "text=Save" },
    { "click": { "role": "button", "name": "Save", "button": "right" } },
    { "shot": "home" },
    { "shot": { "as": "home", "fullPage": true } }
  ]
}
```

A step with nothing to say takes `true`: `{ "back": true }`, `{ "reload": true }`.

Beside its action, any step may carry:

| Key | What it does |
| --- | --- |
| `on` | The session the step is for, by name. Without it, the session `run` was called for. |
| `timeout` | Milliseconds this step may take, in place of the run's or the session's. |
| `message` | What to say if the step fails. It leads the failure, and what actually happened follows in brackets. |
| `note` | A comment for the reader. weblab ignores it. |

`run`

```json
{ "steps": [{ "expect": { "hidden": "#banner" }, "message": "the banner is still there", "timeout": 2000 }] }
```

Each step gets its own `timeout`, else the `timeout` given to `run`, else the session's `timeout`, else 10 seconds. `goto` and `reload` give the app at least 60 seconds to become ready, since a cold dev server can take that long.

An object holding two actions, or none, is refused before any step runs. An option a step doesn't take fails the step, naming the nearest one it does: `shot: no option "fulPage" (did you mean "fullPage"?)`. An option that belongs beside the action, put inside it, is pointed out the same way.

## Targets

Wherever a step takes an element, it takes any of these:

| Target | Finds |
| --- | --- |
| `"button.save"`, `"text=Save"` | A [Playwright selector](https://playwright.dev/docs/other-locators): CSS, `text=`, `role=`, XPath and the rest. |
| `"e12"`, `"f2e12"` | A ref printed by `look`: the element that line described. See [Refs](#refs). |
| `{ "role": "button", "name": "Save" }` | An element by its accessible role and name. A role also takes `level` (for headings), `checked`, `pressed`, `expanded`, `selected` and `disabled`. |
| `{ "label": "Email" }` | A form field by its label. |
| `{ "placeholder": "Search" }` | A field by its placeholder. |
| `{ "text": "Sign in" }` | An element by the text it shows. |
| `{ "testId": "cart" }` | An element by its `data-testid`. |
| `{ "altText": "Logo" }`, `{ "title": "Close" }` | An element by its alt text or title. |
| `{ "component": "CartItem" }`, `"c12"` | In a React app, the first element each instance of a component renders: by its name, or by the id `react` printed for one. See [React](#react). |
| `{ "selector": "li" }` | A selector, in object form, so it can take the options below. |
| `{ "ref": "e12" }` | A ref, in object form. A ref already names one element, so it takes no options. |

The object forms take these options:

| Option | What it does |
| --- | --- |
| `nth` | Which match to use, counting from 0. Without it, the first. |
| `exact` | Match the name or text exactly, rather than as a substring. |
| `frame` | A selector for an iframe to look inside. |
| `within` | Another target to look inside. |

A step's own options sit in the same object as the target, or the target goes whole under `target`:

```json
{ "fill": { "label": "Email", "value": "ada@example.com" } }
{ "click": { "text": "Delete", "within": { "testId": "row-3" } } }
{ "click": { "role": "button", "name": "Inner", "frame": "#frame" } }
{ "shot": { "as": "save-button", "target": { "role": "button", "name": "Save" } } }
```

`expect` reads two of these keys for itself: `text` is text the page or element should show, and `title` alone is the page's title. To check an element found by its title, put it under `target`.

`click`, `hover` and `drag` also take a point, `{ "x": 120, "y": 340 }`, in pixels from the top left of the page: for canvases, maps and anything else with no element to name.

### Refs

`look` prints the page's accessibility tree with a ref on each element (`[ref=e12]`). A ref is prefixed with a document's number, as in `f2e12`, when the element is in a frame or the page has loaded again since the tab opened: Playwright numbers every document but a tab's first. Use a ref as printed, prefix and all. A ref is a target: `{ "click": "e12" }` acts on the element that line described. Refs belong to one session and to its latest `look`:

| After this | Refs |
| --- | --- |
| A `look` (the default `refs` format) | are the ones it printed. Earlier ones are gone. |
| A `look` with a target | are the ones it printed for that element. |
| A `look` with `format: "plain"` | are all gone until the next look. |
| A `look` with `format: "text"` or `"html"` | stay as they were. |
| The page moves to another URL, loads again, or another tab becomes current | are gone until the next look. |

A ref that can't be current fails at once, saying to look again, rather than waiting for an element that can't turn up: `e12 is from a look at http://localhost:5173/, and the page has changed since: run a look step, and use a ref it prints`. Selectors, roles and labels don't depend on a look, so they are what a step file uses.

## Getting around

| Step | Forms | What it does |
| --- | --- | --- |
| `goto` | `"/path"` or `{ url, ready }` | Opens a path or URL, then waits for the app to be ready. A path is resolved against the session's address; a query string is a good way to pose a state. `ready` is `false` to skip the wait, or `{ selector \| text \| js, timeout }` for this step alone. A page that ends up on another site isn't waited for. A page that answers 400 or above is noted (`note  /admin answered 403`). |
| `reload` | `true` or `{ ready }` | Reloads the page, then waits for the app to be ready. |
| `ready` | `true` or `{ selector \| text \| js, timeout }` | Waits for the app to be ready, without going anywhere: for a page still loading, like an app's window that was just opened, or a cold dev server's first build. |
| `back` | `true` | Goes back in the tab's history. Fails if there is no page before this one. |
| `tab` | `1`, `"new"`, `"last"`, `{ open: url }`, `{ close: true }` or `{ close: 1 }` | Switches which tab steps act on. Tabs count from 0. `"new"` waits for a tab the steps haven't been on yet, such as one a click just opened. `"last"` is the newest tab. `open` opens a tab at a path or URL. `close` closes the current tab (steps then act on the newest one left) or a numbered one. |
| `viewport` | `"800x600"` or `{ width, height }` | Resizes the page. |
| `colorScheme` | `"dark"`, `"light"` or `"none"` | Switches the `prefers-color-scheme` the page sees, with no reload. An app with a theme switch of its own needs that switch instead. |

Ready means what the session's `ready` option says, else: `#root` or `#app` has children (where a React or Vue app mounts), or, with neither on the page, the page has loaded. It is waited for up to a minute, unless `ready` gives a `timeout`, since a cold dev server can take that long.

Tabs belong to one session and share its cookies. A second user is a second session, not a tab: see [Sessions](sessions.md).

## Pointer and keyboard

| Step | Forms | What it does |
| --- | --- | --- |
| `click` | target or point, plus `button`, `count`, `modifiers`, `position`, `force` | Clicks. `button` is `"left"`, `"right"` or `"middle"`; `count: 2` double-clicks; `modifiers` is a list like `["Shift"]`; `position` is a point inside the element, from its top left; `force` skips Playwright's checks that the element can be clicked. A point takes only `button` and `count`. |
| `hover` | target or point, plus `modifiers`, `position`, `force` | Moves the pointer over it, and leaves it there. |
| `drag` | `{ from, to }`, each a target or point | Presses at `from`, moves to `to` in small steps, and releases, so sortable lists and canvases see a real drag. |
| `scroll` | target, `{ by: { x, y } }` or `{ to: "top" \| "bottom" }` | A target alone is scrolled into view. `by` and `to` scroll the page, or, with a target beside them, that element: a sidebar, a list, a code block. |
| `press` | `"Enter"` or `{ key, hold, ...target }` | Presses a key or chord (`"?"`, `"Meta+k"`, `"Shift+Tab"`) on the page, or on one element. `hold` keeps it down that many milliseconds before letting go, for keys that act while held; it sends one keydown, not the repeats a held key sends by hand. |
| `type` | `"text"` or `{ value, delay, ...target }` | Types key by key into whatever has focus, or into a target. `fill` sets a value at once; `type` is for fields that react to each key. `delay` is milliseconds between keys. |

While a [video](#recording-a-video) is being recorded, a drawn cursor glides to each click, hover and drag, and each action is followed by a short pause, so the video can be followed. The cursor is hidden while a `shot` is taken, so it is never in a screenshot.

## Forms

| Step | Forms | What it does |
| --- | --- | --- |
| `fill` | `{ value, ...target }` | Sets a field's value at once. |
| `select` | `{ option, ...target }` | Chooses in a `<select>`. `option` is a value or label, a list of them, or `{ index }`. |
| `check` | target, plus `checked` | Ticks a checkbox or radio button, or unticks it with `"checked": false`. |
| `upload` | `{ file, ...target }` or `{ files: [...], ...target }` | Gives files to a file input, hidden ones included, without opening a picker. Any other target (a drop zone, a "Choose file" button) is clicked, and the picker it opens is answered. |

A path in a step (`upload`, a `js` or `playwright` file, a shot's `matches`) is absolute, or relative to the file the step was written in, then the session's project directory, then where weblab was started.

## Checking

| Step | Forms | What it does |
| --- | --- | --- |
| `expect` | `"text"`, or one of the forms below | Checks one thing, retrying until it holds or the step's time runs out, so it is also how to wait for something. Fails if it never holds. |
| `wait` | `1000` | Waits a fixed number of milliseconds. For animations with no end to wait for. |

| Form | Passes when |
| --- | --- |
| `"words"`, `{ "text": "words" }` | The text is visible somewhere on the page, iframes included. A bare string is always text, never a selector. `exact` matches it whole. |
| `{ "visible": target }`, or a target in object form alone (`{ "selector": "#save" }`) | The element is visible. |
| `{ "hidden": target }` | No matching element is visible. |
| `{ "inViewport": target }` | Some of the element is on screen, not just on the page. |
| `{ "noText": "words" }` | The text isn't visible anywhere on the page. |
| `{ ...target, "text": "words" }` | The element's text contains the words. |
| `{ ...target, "count": 3 }` | Exactly that many elements match. |
| `{ ...target, "value": "x" }` | The field holds that value. For a `<select>`, the chosen option's label counts too. |
| `{ ...target, "checked": true }` | The checkbox is ticked (or, with `false`, isn't). |
| `{ ...target, "enabled": true }` | The element is enabled (or, with `false`, disabled). |
| `{ "url": "/cart" }`, `{ "title": "Cart" }` | The page's URL or title matches (see [Matching](#matching)). |
| `{ "request": "**/api/save", "status": 200 }` | The page has had a response from a matching URL since it loaded, with that status if one is given. If none matches, the failure lists the responses that came closest. |
| `{ "console": "loaded" }` | The page has logged a matching console message since it loaded. With `mainProcess`, what the app's main process logged counts too. |
| `{ "noErrors": true }` | The page has logged no console errors and thrown no errors since it loaded, past the session's `ignore`. With `mainProcess`, the main process's console errors count too. Checked once, not retried. An error a `mock` caused on purpose doesn't count. |
| `{ "js": "expression" }` | The expression is truthy in the page. If it never is, the failure says what it was. |
| `{ "electron": "code" }` | The code is truthy in the app's main process, run as the [`electron`](code.md#electron-the-apps-main-process) step runs it. Needs `mainProcess`. If it never is, the failure says what it was. |

"Since it loaded" means since the tab last loaded a document: a `goto` or a reload starts afresh, and a route change inside a single-page app doesn't. To check that one action caused one request, use code: see [Recipes](recipes.md#check-that-nothing-errored-and-that-the-app-called-its-api).

When text or an element never shows, the failure says whether it is on the page but hidden, or not there at all.

An `expect` takes `timeout` and `message` inside it too. A `message` inside replaces the failure text; one beside it, as on any step, leads it.

### Matching

A `url`, `title`, `request` or `console` is matched one of three ways:

| Written as | Matches when |
| --- | --- |
| `"/cart"` | The value contains the string. |
| `"*/cart?step=*"` | The whole value fits the glob, where `*` stands for anything. |
| `{ "regex": "/cart/\\d+$", "flags": "i" }` | The regular expression finds a match. |

## Reading and capturing

| Step | Forms | What it does |
| --- | --- | --- |
| `look` | `true`, `"name"`, or `{ as, format, depth, ...target }` | Reads the page, or one element, as text, and hands it back in the reply. Given a name (`as`), it is also kept in `looks/`. `format` is `refs` (the accessibility tree with refs to act on; the default), `plain` (the tree without refs, shorter), `text` (the words as a reader sees them: best for long articles and code), or `html` (all the markup, hidden parts included, which can be large). `depth` keeps only the top levels of the tree. On a big page, read the part you need: `{ "look": { "role": "dialog" } }`, `{ "look": { "selector": "main", "depth": 3 } }`. |
| `shot` | `"name"` or `{ as, fullPage, clip, animations, screen, matches, tolerance, ...target }` | Screenshots the viewport, the full page (`fullPage`), a part of either (`clip`: `{ x, y, width, height }` in CSS pixels, from the top left of the viewport, or of the page with `fullPage`), or one element, to `shots/<session>-<name>.png`, and hands it back as an image. With `screen`, it captures the real screen instead. With `matches`, it is held to a screenshot taken before. |
| `video` | `"start"`, `"stop"`, or `{ as, ready }` to start | Records the tab steps act on, from `start` until `stop` or the end of the session. See [Recording a video](#recording-a-video). |

`as` is the name a `look` or `shot` is kept under; `name` beside `role` is an element's accessible name.

A `shot` waits for nothing, so check first, with `expect`, for what should be there. To keep captures steady, it finishes CSS animations and transitions (and resets endless ones) for the moment it captures, unless given `"animations": true`. A full-page shot first loads every image marked `loading="lazy"`, which would otherwise stay blank below the fold, and notes any that were still loading. It captures the page's own scroll: when an app scrolls inside an element instead, capture that element.

### Holding a shot to one taken before

`matches` names an earlier screenshot, and the step fails if the new one differs from it:

```json
{ "shot": { "as": "home", "matches": "/tmp/before/shots/main-home.png" } }
```

The failure says how many pixels differ, and keeps a picture beside the shot, `shots/<session>-home.diff.png`, with what differs in red over a faded copy. `tolerance` is the share of pixels that may differ and still pass, from 0 to 1 (`0.01` is one percent; the default is none). Pixels whose colours are nearly the same count as the same. The two shots have to be the same size.

### The real screen

A browser's own screenshots hold only what the page draws. What the operating system draws over it is missing: an open `<select>`, a context menu, a date or colour picker, autofill. `screen` captures the browser as it shows on the real screen, with those on it:

| `screen` | Captures |
| --- | --- |
| `"page"`, or `true` | The page's part of the browser window, or a target's part of it. |
| `"window"` | The whole window, toolbar included. |
| `"display"` | The whole display the window is on, with everything else on it. |

`run`

```json
{ "steps": [{ "click": { "label": "Size" } }, { "shot": { "as": "size-menu", "screen": true } }] }
```

A page, element or window capture holds this browser's window and the menus it has open, and nothing else, even when another window lies over it. It needs:

- **A window**: a session opened with `headed`, or one that attached to a running browser or app. A headless session is refused.
- **A Chromium browser**, since it asks the browser where its window is over the DevTools protocol.
- **Screen recording allowed** for the app weblab runs under (the terminal, or the agent's app), in System Settings > Privacy & Security > Screen & System Audio Recording. weblab says so if it isn't.
- Not `fullPage`: the screen shows only what is in the window.

A session with a window wakes the display and keeps it awake while weblab runs, brings its window to the front at each `click` and `press` (the OS opens its menus only for the window in front), and draws at the display's own pixel scale unless `viewport` gives one, so what the OS draws lines up with the page. Another window coming to the front closes an open menu, so open it and capture it in the same `run`.

### Recording a video

A video holds what happens between `{ "video": "start" }` and `{ "video": "stop" }`, so set things up first (sign in, open the right page) and start where the part worth watching begins:

`run`

```json
{ "steps": [{ "goto": "/cart" }, { "video": "start" }, { "click": "text=Checkout" }, { "expect": "Order placed" }, { "video": "stop" }] }
```

```text
ok    1 goto (412ms)
ok    2 video (281ms)
ok    3 click (1544ms)
ok    4 expect (35ms)
ok    5 video (2101ms)
file  $TMPDIR/weblab/shop-20261003-101600/videos/main.webm
```

- Starting waits for the app to be ready first, as `goto` does, so a video never opens on a blank page that is still loading. `ready` is `false` to start at once, or `{ selector | text | js, timeout }` for what to wait for.
- `as` names the file: `{ "video": { "as": "checkout" } }` is `videos/<session>-checkout.webm`. Without it, the first take is `videos/<session>.webm` and later ones `<session>-take2.webm`, and so on.
- A failed step stops the run, not the take: the reply notes it is still recording. For a clean take, stop it and start a new one once the steps work.
- Stopping holds the last frame for two seconds, so the outcome can be read, and hands back the file. A take still going when its session ends is written then, and `end` names it.
- A tab the steps move to with `tab` during a take is recorded too, to a file of its own (`<take>-tab1.webm`). Closing it with `tab` keeps its file, but a tab the page closes by itself takes its recording with it.
- It works the same in every browser, and in a browser or app the session attached to.

## Around the page

| Step | Forms | What it does |
| --- | --- | --- |
| `dialog` | `"accept"`, `"dismiss"`, or `{ accept, text }` | Decides what happens to the `alert`, `confirm` and `prompt` dialogs that open from now on. `text` answers a prompt. Until told otherwise, weblab dismisses them. Each one is noted in the console log and the reply: `[dialog confirm] Sure? (dismissed)`. |
| `mock` | `{ url, json \| body \| abort \| off, status, contentType }` | Answers matching requests locally, in every tab of the session. `url` is a [Playwright URL glob](https://playwright.dev/docs/api/class-page#page-route) such as `"**/api/me"`. `json` answers with data, `body` with text, `status` sets the status (100 to 599), `abort` makes the requests fail, and `off` removes the mock. A new mock for the same `url` replaces the old one. Answered requests are marked `(mocked)` in the network log. |
| `saveState` | `"name"` | Saves the session's cookies and storage under a name, for a later session to start from with `state`. See [Sessions](sessions.md#saved-sign-ins). |

## Code

| Step | Forms | What it does |
| --- | --- | --- |
| `js` | `"expression"` or `{ file }` | Runs JavaScript in the page and hands back its value. A promise is awaited. |
| `css` | `"css"` | Adds a stylesheet to the page, kept through reloads and new tabs for the rest of the session. |
| `playwright` | `"code"` or `{ file }` | Runs Playwright code against the page and hands back what it returns. |
| `cdp` | `"Domain.method"` or `{ method, params }` | Sends one raw Chrome DevTools Protocol command and hands back its result. Chromium browsers only. |
| `electron` | `"code"` or `{ file }` | Runs JavaScript in an attached Electron app's main process and hands back its value. Needs `mainProcess`. |

[Code](code.md) covers what each is handed, and what they make possible.

## React

| Step | Forms | What it does |
| --- | --- | --- |
| `react` | `"tree"`, `"renders"`, or `{ tree \| inspect \| renders \| set \| suspend \| error: component, ...options }` | Reads a React app's components and what made them render, and changes their props, state and boundaries, the way React DevTools does. |

| Form | What it does |
| --- | --- |
| `{ "react": "tree" }` | Hands back the app's components as a tree, each with an id to name it by. `{ "react": { "tree": "Cart" } }` starts at one component. |
| `{ "react": { "inspect": "Cart" } }` | Hands back one component: where its code is, what rendered it, its props, hooks and state, and the context it reads. |
| `{ "react": "renders" }` | Hands back what rendered since it was last asked (the first time, since the page loaded), how often, and why. `{ "react": { "renders": "Cart" } }` keeps to one component and what is inside it. |
| `{ "react": { "set": "Cart", "hook": 0, "value": [] } }` | Changes a prop, a hook's state, or a class component's state, and lets React render it. |
| `{ "react": { "suspend": "Products" } }` | Makes the `Suspense` boundary around the component show its fallback, until `{ "react": { "suspend": false } }`. |
| `{ "react": { "error": "Checkout" } }` | Makes the error boundary around the component show its error state, until `{ "react": { "error": false } }`. |

It works with a development build of React 16.14 or later, in any browser and with any bundler or framework. Forcing an error boundary needs React 18 or later. In a production build, names are minified, there are no source locations, and nothing can be changed. The first `react` step on such a page says so.

The tree is the app's components, each with what it was given (a key, a few short props) and its id:

```text
- root <div#root>
  - App [c1]
    - ThemeContext.Provider value="light" [c96]
      - Header [c5]
      - ProductGrid query="" [c6]
        - ProductCard key="kettle" [c12]
        - ProductCard key="lamp" [c26]
      - Cart [c9]
(104 components from node_modules left out, shown with "library": true)
```

And `inspect` opens one of them:

`run`

```json
{ "steps": [{ "react": { "inspect": { "role": "button", "name": "Add Mug" } } }] }
```

```text
ok    1 react (24ms)

ProductCard [c40] memo, compiled by React Compiler
key      "mug"
source   src/components/ProductCard.tsx:7:22
used at  src/components/ProductGrid.tsx:14:9
owners   ProductGrid < App
elements <div.card>
via      Primitive.button.Slot [c50] from @radix-ui/react-tooltip rendered the element ("library": true inspects it)
renders  1 since the page loaded
props
  product: { id: "mug", name: "Mug", price: 12 }
  onAdd: ƒ t1()
```

`source` is where the component's own code is, and `used at` is the line in its parent's code that writes `<ProductCard>`. Both point into the project's own files, through the page's source maps.

### Naming a component

Every form names a component, except bare `"tree"` and `"renders"`. There are three ways to name one:

| Written as | Names |
| --- | --- |
| `"CartItem"` | The first component with that name, in the order of the tree. `nth` beside it picks a later one, counting from 0. |
| `"c12"` | The component the tree, `inspect` or `renders` printed that id for. |
| Any target: `{ "role": "button", "name": "Pay" }`, `"e12"` | The app's own component that rendered that element. |

```json
{ "react": { "inspect": "CartItem", "nth": 1 } }
{ "react": { "inspect": { "text": "Socks" } } }
{ "react": { "error": "c12" } }
```

An id lasts as long as the tab: after a reload, the ids from before name nothing. A component that unmounted is gone, and its id with it.

Other steps can name a component as a target, `{ "component": "Checkout" }` or `"c12"`, which means the first element it renders: `{ "click": { "component": "Checkout" } }`.

When the element a target names was written by a different component from the one that rendered it, as with a wrapper that renders its `children`, `inspect` says so on a `written` line.

### Options

| Option | Taken by | What it does |
| --- | --- | --- |
| `nth` | All | Which component of that name, counting from 0. |
| `library` | All | Treats components from `node_modules` as the app's own: `tree` and `renders` show them, `inspect` lists their hooks in full, and an element names the library component that rendered it. See [Components from libraries](#components-from-libraries). |
| `depth` | `tree` | How many levels to show. |
| `hook`, `prop`, `state` | `inspect`, `set` | Which value: a hook by the number `inspect` gives it, a prop by name, or a class component's state. A path can go inside it: `"3.data.pages"` or `[3, "data", "pages"]`. Given to `inspect`, it hands back that one value in full. |
| `value` | `set` | The value to set, as JSON. |
| `js` | `set` | An expression run in the page, for a value JSON can't hold, such as a Set or a Date: `"new Set(['a'])"`. |
| `keep` | `renders` | Hands back what was counted without clearing it. |

An option an action doesn't take is refused, not ignored.

### What renders says

`run`

```json
{ "steps": [{ "react": "renders" }, { "type": { "placeholder": "Search products", "value": "t" } }, { "react": "renders" }] }
```

```text
ok    1 react (3ms)

3 commits since the last time asked (12.2 ms rendering), 95 components rendered
  ...
ok    2 type (6ms)
ok    3 react (2ms)

2 commits since the last time asked (0.4 ms rendering), 5 components rendered
  App [c1] (compiled)     1×    0.2 ms  state changed: hook 1 (useState) "" → "t"
  ProductGrid [c6]        1×   <0.1 ms  props changed: query
unmounted: ProductCard ×3
(3 renders of 3 components from node_modules left out, shown with "library": true)
```

A commit is one time React updates the page, and one commit can render many components. Each line is a component, how many times it rendered, how long it took itself (its children aside), and why. Three or more instances of one component, like a list's items, share a line. `(compiled)` marks a component the React Compiler compiled. The reasons:

| Reason | What happened |
| --- | --- |
| `mounted` | The component appeared. |
| `props changed: item` | A prop has a new value. For an object, `(inside: qty)` says which of its keys changed. |
| `props new but equal: style` | A prop is a new object, array or element with the same contents as before. Making it once would save the render. |
| `state changed: hook 2 (useCart › useState) [] → Array(1)` | A hook's state changed: which hook, the custom hooks it is called in, and from what to what. For an object, which of its keys changed: `hook 3 (useQuery): status "pending" → "success", data`. |
| `context changed: ThemeContext` | A context it reads has a new value. |
| `parent rendered (props equal)` | Its parent rendered and its props came out the same. `memo` would save the render. Under a compiled parent it also says that the parent made the element again, so something the element was made from changed. |
| `rendered (nothing it reads changed)` | It rendered with nothing it reads changed, as after a `forceUpdate`. |

Asking clears what was counted, so the next time says what happened in between. Asking about one component clears only what is within it. `"keep": true` hands it back and keeps counting.

### Changing a component

`set` changes one value and waits for React to render it:

```json
{ "react": { "set": "Counter", "hook": 0, "value": 5 } }
{ "react": { "set": "Header", "prop": "title", "value": "Draft" } }
{ "react": { "set": "Settings", "hook": "2.user.name", "value": "Ada" } }
{ "react": { "set": "Forest", "hook": "35.shelved", "js": "new Set(['a'])" } }
```

The reply names what changed: `hook 0 of Counter [c3] set to 5`. Only `useState` and `useReducer` hooks hold state that can be set. A hook of another kind is refused, and `inspect` shows which is which. A prop stays changed until the component's parent renders it again. A context's value is its provider's `value` prop, so setting that changes what every component reading it sees. A provider is named as the tree shows it: `ThemeContext.Provider` for a context with a `displayName`, else `Context (from ThemeProvider).Provider`.

If the change makes the app throw, the step says so, and says whether an error boundary caught it or React unmounted the tree.

`suspend` and `error` act on the nearest boundary around the component, and the reply names it: `Suspense [c14] in App shows its fallback`. An error boundary is a class component with `getDerivedStateFromError` or `componentDidCatch`. With none around the component, the step fails and says so. A forced error lasts until `{ "error": false }`, or until the app resets the boundary itself, and what the boundary holds then mounts again from scratch. The error React logs for it is weblab's, and is left out of the console log.

### Components from libraries

`tree` and `renders` leave out components from `node_modules`, like a UI kit's buttons or a router's internals, and show what those render in their place. A line at the end says how many were left out. Named by an element, `inspect` goes to the app's own component and names the library's on its `via` line.

`inspect` shows a library's custom hook as one line, with the state it holds (and, for a query, its key), rather than every hook inside it:

```text
hooks
  0-4 useQuery ["products"] → { status: "success", data: Array(6), error: null }
```

`"library": true` takes library components in, in all of these. A reply about a boundary from a library names its package.

weblab tells a library's components by the file their code is in. When a bundler packs `node_modules` into chunks of its own, weblab finds the file through the chunks' source maps. This goes for server components too. A tool that renders with its own production build of React next to the app's development build (a framework's development overlay, say) is left out whole, with everything it renders.

### Server components

A React server component runs on the server, so the page has what it rendered but not the component itself. The tree shows it where it rendered, marked `(server)`, with its props:

```text
- root #document
  - RootLayout (server)
    - Home (server)
      - Heading (server) text="Welcome"
      - Counter label="clicks" [c47]
```

It has no id, as there is nothing of it in the page to inspect or change, and asking to inspect one by name says so. `{ "react": { "tree": "Home" } }` shows what it rendered. A client component it rendered names it among its owners, and its `used at` line points at the server component's file, and at the line too when the server's code has a source map. Named by an element a server component wrote, `inspect` opens the client component around the element and names the server component on its `written` line. Server components don't render in the page, so `renders` doesn't count them.

### How weblab sees React

React looks for a hook in the page as it loads, the one React DevTools installs, and tells it about every render. weblab puts that hook in each page before the page's own scripts: from the first page, for a project whose `package.json` depends on `react`, and otherwise from the first `react` step on. That is how `renders` sees every render from the first, and how `set`, `suspend` and `error` change things through React itself.

In a browser or app weblab joined with `attach`, the page was already loaded. The components are found from the page, and renders are counted from a hook already there, if there is one (React Refresh's, in a Vite or Next.js dev server). Changing things and naming custom hooks need weblab's hook. `{ "reload": true }` loads the page again with it, and from then on it works as it does from the start. The same goes for a page a `react` step meets before weblab's hook was in it. Whatever weblab added goes when the session ends.

To find a component's code and name its custom hooks, weblab calls the component once more, outside a render, as React DevTools does. Each hook hands back what React holds for it, and the stack of each call says which custom hooks it was called in. `inspect` does this for the component it opens, and `tree` and `renders` once for each kind of component, to tell the app's from a library's. Components are meant to be safe to call like that (React calls them twice in Strict Mode). Anything one logs meanwhile is left out, but other side effects of rendering happen again.

In what weblab prints, text under names that hold secrets, like `password`, `token` or `apiKey`, is shown as `[redacted]`. `weblab.react` hands back the values as they are. A context without a `displayName` is named after the component that provides it: `Context (from DropsProvider)`.

### weblab.react in code

Every page also has `weblab.react`, for `js` steps and checks:

| Call | Hands back |
| --- | --- |
| `weblab.react.find("Cart")` | Each component with that name (or id) as `{ id, name, key, props, state }`. `state` is a class component's state, or a function component's state hooks by number. |
| `weblab.react.of(element)` | The component that rendered an element, the same way. |
| `weblab.react.set("Cart", "hook", [0], value)` | What `set` does, with any value code can make. It returns a promise that resolves once React has rendered. |
| `weblab.react.fiber("Cart")` | React's own record of the component, for code that reads React's internals. |
| `weblab.react.commits` | How many times React has updated the page since weblab began watching it: since it loaded, in a browser weblab opened. |

```json
{ "expect": { "js": "weblab.react.find('CartItem').length === 3" } }
{ "js": "weblab.react.find('Player')[0].props.track.title" }
```

Props and state are the app's own values. Functions and DOM nodes don't come out of the page, so hand back the part you want: `.props.track.title`, not `.props`.

## More than one session

| Step | Forms | What it does |
| --- | --- | --- |
| `new` | `"name"`, `true`, or `{ name, address, start, attach, state, viewport, ... }` | Opens another session, as the `new` tool does, and goes to its first page. It takes every argument the tool takes. What it doesn't say is as the session the step is on: the same address, size, browser and so on, but never its sign-in. |
| `end` | `"name"`, or `true` for the session the step is on | Ends a session, as the `end` tool does. |

`run`

```json
{
  "steps": [
    { "goto": "/room/1" },
    { "new": "guest" },
    { "goto": "/room/1", "on": "guest" },
    { "fill": { "label": "Message", "value": "hello" } },
    { "press": "Enter" },
    { "expect": "hello", "on": "guest" },
    { "shot": "received", "on": "guest" }
  ]
}
```

A session a step opens stays open after the run, until something ends it. [Sessions](sessions.md) covers what it inherits and the other ways to use more than one.

## Reusing steps

### include

| Step | Forms | What it does |
| --- | --- | --- |
| `include` | `"file.json"` or `{ file, ...params }` | Runs the steps in a JSON file, in place, filling its placeholders from the include's own keys and then the run's `params`. |

- The path is relative to the file the include is in. In steps given to `run` directly, it is relative to the session's project directory.
- A `timeout`, `message` or `on` on the include applies to every step it brings in that doesn't set its own. So one sign-in file serves every session: `{ "include": "sign-in.json", "on": "guest" }`.
- A step an include brought in names its file in the reply: `ok    5 fill (sign-in.json step 1)`.
- An include can't bring in code; run a code file with `{ "playwright": { "file": "check.ts" } }`.
- Includes nest up to ten deep.

`sign-in.json`:

```json
[
  { "fill": { "label": "Email", "value": "${email}" } },
  { "fill": { "label": "Password", "value": "${password}" } },
  { "click": { "role": "button", "name": "Sign in" } }
]
```

`run`

```json
{ "steps": [{ "goto": "/login" }, { "include": { "file": "/tmp/sign-in.json", "email": "ada@example.com", "password": "hunter2" } }] }
```

### Placeholders

`${name}` in a step is filled from `params`; `${name=default}` gives a value to use when nothing else does.

- A string that is nothing but one placeholder takes the value's own type: `"count": "${count}"` with `params: { "count": 3 }` is the number 3. A default that reads as a number, `true`, `false` or `null` is that: `"status": "${status=200}"` is the number 200.
- In an included file, a placeholder nothing fills is an error: `greet.json: needs "who", which neither the include nor params gave (or write ${who=default})`.
- In steps given to `run` directly, and in a file given as `file`, a placeholder nothing fills stays as written.
- Inside code steps (`js`, `css`, `playwright`, `cdp`), a placeholder nothing fills is the code's own, such as a template literal, and stays as it is.

`run`

```json
{ "steps": [{ "goto": "/orders/${order}" }, { "expect": "Order ${order}" }], "params": { "order": 1042 } }
```

### Step files

`run` with `file` runs the steps in a file. A JSON file holds a list of steps, one step, or `{ "steps": [...] }` and nothing else. How a session is driven (its viewport, its browser) isn't part of a file; that is said when the session is opened. Paths in a file's steps are read relative to the file. A `.ts`, `.mts`, `.js` or `.mjs` file is code: see [Code](code.md#code-files).

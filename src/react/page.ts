// What runs inside the page to see React: the hook React looks for as
// it loads (the one React DevTools installs), and `weblab.react`, which
// the react step and the `component` target read through.
//
// Installed before the page's own scripts, as weblab's sessions do, it
// is told of every renderer and every commit, so it can say what
// rendered and why, and change props, state and boundaries through the
// renderer the way DevTools does. Installed late (an attached browser,
// or the component target on a page loaded before), it finds React's
// roots from the DOM instead, and joins a hook already there (React
// Refresh's, or DevTools') to watch commits from then on.
//
// It is passed to the page as source, so nothing outside the function
// is reached from inside it.

/**
 * Installs the hook (when `early`) and `window.weblab.react`, once per
 * document. `reactOwn` is the pattern of React's own files, as
 * src/sources.ts keeps it: this function is passed as source, and can't import.
 */
export const reactInPage = ({ early, reactOwn }: { early: boolean; reactOwn: string }) => {
  const page = window as any;
  if (page.weblab?.react !== undefined) return;

  type Fiber = any;
  type Renderer = any;
  // Fiber tags, the same since React 16.
  const FUNCTION = 0, CLASS = 1, ROOT = 3, HOST = 5, TEXT = 6, PROVIDER = 10, FORWARD_REF = 11, SUSPENSE = 13, MEMO = 14, SIMPLE_MEMO = 15, HOISTABLE = 26, SINGLETON = 27, ACTIVITY = 31;
  const COMPOSITE = new Set([FUNCTION, CLASS, FORWARD_REF, SIMPLE_MEMO]);
  const HOSTS = new Set([HOST, TEXT, HOISTABLE, SINGLETON]);
  // A fiber that rendered in the commit just made, rather than bailing out.
  const PERFORMED_WORK = 1;

  const renderers = new Map<number, Renderer>();
  const rootRenderer = new Map<object, number>();
  const roots = new Set<any>();
  let commits = 0;
  let everRendered = false;
  // Whether commits are seen: "start" when the hook was there before React,
  // "late" when it joined one already there, "none" when there was none to join.
  let watching: "start" | "late" | "none" = "none";

  // ---- ids: c1, c2, ... for each component, the same for its alternate.
  // They go on counting in a tab across its loads (kept in its session
  // storage), so an id from before a reload names nothing rather than
  // something else.

  const ids = new WeakMap<object, number>();
  const byId = new Map<number, WeakRef<Fiber>>();
  const ID_KEY = "__weblabReactIds";
  const storage = (() => {
    try {
      return page.sessionStorage as Storage;
    } catch {
      return null;
    }
  })();
  let lastId = Number(storage?.getItem(ID_KEY) ?? 0) || 0;
  let saving = false;
  const knownId = (fiber: Fiber): number => ids.get(fiber) ?? (fiber.alternate ? ids.get(fiber.alternate) : undefined) ?? -1;
  const idOf = (fiber: Fiber): number => {
    let id = knownId(fiber);
    if (id === -1) {
      id = ++lastId;
      byId.set(id, new WeakRef(fiber));
      if (storage && !saving) {
        saving = true;
        queueMicrotask(() => {
          saving = false;
          try {
            storage.setItem(ID_KEY, String(lastId));
          } catch {
            // Storage full or refused: ids may then repeat after a reload.
          }
        });
      }
    }
    ids.set(fiber, id);
    if (fiber.alternate) ids.set(fiber.alternate, id);
    return id;
  };

  // What a step asked for that isn't there: the step was written wrong, not the app.
  const refuse = (message: string) => Object.assign(new Error(message), { name: "WeblabRefused" });

  // ---- names

  const typeName = (type: any): string => {
    if (typeof type === "string") return type;
    if (type == null) return "Anonymous";
    return type.displayName || type.name || (type.render ? typeName(type.render) : type.type ? typeName(type.type) : "Anonymous");
  };
  const nameOf = (fiber: Fiber): string => {
    switch (fiber.tag) {
      case PROVIDER: {
        // React 19 renders the context itself as its provider, and earlier ones an object holding it.
        const context = fiber.type?._context ?? fiber.type;
        return context?.displayName ? `${context.displayName}.Provider` : `${contextName(context, { return: fiber })}.Provider`;
      }
      case SUSPENSE:
        return "Suspense";
      case ACTIVITY:
        return "Activity";
      case SIMPLE_MEMO:
      case MEMO:
        return fiber.elementType?.displayName || typeName(fiber.type);
      default:
        return typeName(fiber.type);
    }
  };
  const KINDS: Record<number, string> = { [CLASS]: "class", [FORWARD_REF]: "forwardRef", [SIMPLE_MEMO]: "memo", [SUSPENSE]: "Suspense boundary", [PROVIDER]: "context provider", [ACTIVITY]: "Activity" };
  const kindOf = (fiber: Fiber): string => KINDS[fiber.tag] ?? "function";
  /** A component as replies name it: `CartItem [c12]`. */
  const label = (fiber: Fiber) => `${nameOf(fiber)} [c${idOf(fiber)}]`;
  /** The fiber at the top of a fiber's tree: its root's, while it is mounted. */
  const topOf = (fiber: Fiber) => {
    let top = fiber;
    while (top.return) top = top.return;
    return top;
  };
  /** The component that rendered a fiber, past memo(component, compare)'s fiber of its own. */
  const ownerOf = (fiber: Fiber) => {
    let owner = fiber?._debugOwner;
    while (owner && owner.tag === MEMO) owner = owner._debugOwner;
    return owner ?? null;
  };
  /** What a component's type is kept by: its function or class (or memo, or context). */
  const typeKey = (fiber: Fiber): object | null => {
    const type = fiber.type;
    return type && (typeof type === "function" || typeof type === "object") ? type : null;
  };

  // ---- roots and walking

  // Roots from the DOM, for a page whose React loaded before the hook did.
  const rootsInDom = (): any[] => {
    const found: any[] = [];
    for (const element of document.querySelectorAll("*")) {
      const key = Object.keys(element).find((name) => name.startsWith("__reactContainer$"));
      const fiberRoot = key ? (element as any)[key]?.stateNode : (element as any)._reactRootContainer?._internalRoot;
      if (fiberRoot?.current) found.push(fiberRoot);
    }
    return found;
  };
  // Watching from the start, every root has been seen committing. Otherwise
  // the DOM has the rest, scanned again only once React has committed since,
  // or, when weblab can't see commits, a moment has passed.
  let scanned: { roots: any[]; commits: number; at: number } | null = null;
  const fresh = (kept: { commits: number; at: number } | null) =>
    kept !== null && kept.commits === commits && (watching !== "none" || performance.now() - kept.at < 250);
  const allRoots = (): any[] => {
    const known = [...roots].filter((root) => root.current?.child);
    if (watching === "start") return known;
    if (!fresh(scanned)) scanned = { roots: rootsInDom(), commits, at: performance.now() };
    return [...new Set([...known, ...(scanned as { roots: any[] }).roots])];
  };

  // Every fiber of the trees as they now stand, in order, with the one
  // above it: a fiber's own `return` can still be its parent's alternate.
  function* walk(from?: Fiber): Generator<[Fiber, Fiber | null]> {
    const starts = from ? [from] : allRoots().map((root) => root.current);
    for (const start of starts) {
      const stack: [Fiber, Fiber | null][] = [[start, null]];
      while (stack.length > 0) {
        const [fiber, parent] = stack.pop() as [Fiber, Fiber | null];
        yield [fiber, parent];
        const children: Fiber[] = [];
        for (let child = fiber.child; child; child = child.sibling) children.push(child);
        for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], fiber]);
      }
    }
  }

  // A fiber and its alternate stand for one component, and which of the
  // two is in the tree changes with each commit. The fibers in the trees now
  // are gathered once, until React commits again. One no longer in them
  // (unmounted) is no longer anywhere.
  let live: { fibers: Set<Fiber>; commits: number; at: number } | null = null;
  const current = (fiber: Fiber): Fiber | null => {
    if (!fresh(live)) {
      const fibers = new Set<Fiber>();
      for (const [seen] of walk()) fibers.add(seen);
      live = { fibers, commits, at: performance.now() };
    }
    const now = (live as { fibers: Set<Fiber> }).fibers;
    return now.has(fiber) ? fiber : fiber.alternate && now.has(fiber.alternate) ? fiber.alternate : null;
  };
  /** The component with an id, as it now stands, or null once it has unmounted. */
  const byIdNow = (id: number): Fiber | null => {
    const fiber = byId.get(id)?.deref();
    return fiber ? current(fiber) : null;
  };

  const fiberOfNode = (node: any): Fiber | null => {
    for (const key in node) if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return node[key];
    return null;
  };
  // The component nearest above a fiber.
  const componentOf = (fiber: Fiber | null): Fiber | null => {
    for (let at = fiber; at; at = at.return) if (COMPOSITE.has(at.tag)) return at;
    return null;
  };
  // The DOM nodes a component renders at its top: what is on the page of it.
  const hostsOf = (fiber: Fiber): Element[] => {
    const found: Element[] = [];
    const visit = (at: Fiber | null) => {
      for (; at; at = at.sibling) {
        if (HOSTS.has(at.tag)) {
          if (at.stateNode instanceof Element) found.push(at.stateNode);
        } else if (!(at.tag === SUSPENSE && at.memoizedState !== null && at.child?.sibling)) {
          visit(at.child);
        } else {
          // A suspended boundary keeps what it hid as its first child, and shows its fallback after.
          visit(at.child.sibling);
        }
      }
    };
    visit(fiber.child);
    return found;
  };

  /** The component a target names: its id (c12), or the nth (from 0) with that name. Throws saying why when none does. */
  const resolve = (target: any, nth = 0): Fiber => {
    if (target instanceof Node) {
      const owner = componentOf(fiberOfNode(target) ?? (target.parentElement ? fiberOfNode(target.parentElement) : null));
      if (owner === null) throw new Error(`no React component rendered ${describeNode(target)}`);
      return current(owner) ?? owner;
    }
    const id = /^c(\d+)$/.exec(String(target));
    if (id) {
      const now = byIdNow(Number(id[1]));
      if (now === null) {
        const fiber = byId.get(Number(id[1]))?.deref();
        throw refuse(`${target} is not on the page now: ${fiber ? "it unmounted" : "it is from before the page last loaded, or was never given"}. { "react": "tree" } lists the ones that are`);
      }
      return now;
    }
    const matches = find(String(target));
    if (matches[nth] === undefined) {
      if (matches.length > 0) throw refuse(`there ${matches.length === 1 ? "is one" : `are ${matches.length}`} ${target}, so no nth ${nth} (nth counts from 0)`);
      const names = new Set<string>();
      for (const [fiber] of walk()) if (COMPOSITE.has(fiber.tag)) names.add(nameOf(fiber));
      if (serverNames().has(String(target))) {
        throw refuse(`${target} is a server component: it rendered on the server, so the page holds only what it rendered, not it. { "react": "tree" } shows it, and the components it rendered`);
      }
      throw Object.assign(refuse(`no component named ${target} is on the page`), { names: [...names, ...serverNames()] });
    }
    return matches[nth];
  };
  /** The components a name or an id stands for. */
  const fibersFor = (name: string): Fiber[] => (/^c\d+$/.test(name) ? [resolve(name)] : find(name));
  const find = (name: string): Fiber[] => {
    const found: Fiber[] = [];
    for (const [fiber] of walk()) if ((COMPOSITE.has(fiber.tag) || fiber.tag === SUSPENSE || fiber.tag === PROVIDER) && nameOf(fiber) === name) found.push(fiber);
    return found;
  };

  // ---- values, as short text

  const describeNode = (node: any): string => {
    if (!(node instanceof Element)) return node?.nodeName?.toLowerCase() ?? "a node";
    const id = node.id ? `#${node.id}` : "";
    const classes = typeof node.className === "string" && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `<${node.tagName.toLowerCase()}${id}${classes}>`;
  };
  // What a key holding a secret is called: its value is never shown, so it never lands in a transcript.
  const SECRET = /pass(word|wd|phrase)|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;
  const secret = (key: unknown, value: unknown) => typeof key === "string" && typeof value === "string" && value !== "" && SECRET.test(key);
  const kept = (key: string, value: unknown, show: () => string) => (secret(key, value) ? "[redacted]" : show());
  const ELEMENTS = new Set([Symbol.for("react.element"), Symbol.for("react.transitional.element")]);
  const preview = (value: any, depth = 2, seen = new Set<any>()): string => {
    switch (typeof value) {
      case "string":
        return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
      case "function":
        return `ƒ ${value.name || ""}()`;
      case "bigint":
        return `${value}n`;
      case "symbol":
        return value.toString();
      case "object":
        break;
      default:
        return String(value);
    }
    if (value === null) return "null";
    if (seen.has(value)) return "[circular]";
    if (ELEMENTS.has(value.$$typeof)) return `<${typeName(value.type)} />`;
    if (typeof Node !== "undefined" && value instanceof Node) return describeNode(value);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof Promise) return "Promise";
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (depth === 0) return value.length === 0 ? "[]" : `Array(${value.length})`;
        const items = value.slice(0, 5).map((item) => preview(item, depth - 1, seen));
        return `[${items.join(", ")}${value.length > 5 ? `, …${value.length - 5} more` : ""}]`;
      }
      if (value instanceof Map || value instanceof Set) {
        const kind = value instanceof Map ? "Map" : "Set";
        if (depth === 0 || value.size === 0) return `${kind}(${value.size})`;
        const entries = [...value].slice(0, 4).map((entry) => (value instanceof Map ? `${preview(entry[0], 0, seen)} => ${preview(entry[1], depth - 1, seen)}` : preview(entry, depth - 1, seen)));
        return `${kind}(${value.size}) {${entries.join(", ")}${value.size > 4 ? ", …" : ""}}`;
      }
      const keys = Object.keys(value);
      const kind = value.constructor && value.constructor !== Object && value.constructor.name ? `${value.constructor.name} ` : "";
      if (keys.length === 0) return `${kind}{}`;
      if (depth === 0) return `${kind}{…}`;
      const fields = keys.slice(0, 6).map((key) => `${/^[\w$]+$/.test(key) ? key : JSON.stringify(key)}: ${kept(key, value[key], () => preview(value[key], depth - 1, seen))}`);
      return `${kind}{ ${fields.join(", ")}${keys.length > 6 ? `, …${keys.length - 6} more` : ""} }`;
    } finally {
      seen.delete(value);
    }
  };

  // A value in full, a few levels down, one key to a line: for a value inspect would cut short.
  const expand = (value: any, depth: number, indent: string, seen = new Set<any>()): string => {
    // A string in full here (up to a long limit): this is where one cut short elsewhere is read.
    if (typeof value === "string") return ` ${JSON.stringify(value.length > 4000 ? `${value.slice(0, 4000)}…` : value)}`;
    const leaf = typeof value !== "object" || value === null || ELEMENTS.has(value.$$typeof) || value instanceof Date || value instanceof RegExp || (typeof Node !== "undefined" && value instanceof Node);
    if (leaf || depth === 0 || seen.has(value)) return ` ${seen.has(value) ? "[circular]" : preview(value, leaf ? 2 : 0)}`;
    seen.add(value);
    const entries: [unknown, unknown][] = value instanceof Map ? [...value] : value instanceof Set ? [...value].map((item, i) => [i, item]) : Array.isArray(value) ? value.map((item, i) => [i, item]) : Object.entries(value);
    const kind = Array.isArray(value) ? `Array(${value.length})` : value instanceof Map ? `Map(${value.size})` : value instanceof Set ? `Set(${value.size})` : value.constructor && value.constructor !== Object && value.constructor.name ? value.constructor.name : "";
    const lines = entries.slice(0, 50).map(([key, item]) => `\n${indent}  ${String(key)}:${secret(key, item) ? " [redacted]" : expand(item, depth - 1, `${indent}  `, seen)}`);
    seen.delete(value);
    const more = entries.length > 50 ? `\n${indent}  …${entries.length - 50} more` : "";
    return `${kind ? ` ${kind}` : ""}${entries.length === 0 ? " (empty)" : ""}${lines.join("")}${more}`;
  };

  // ---- hooks

  // How many of the fiber's hook slots each hook React lists takes. A
  // hook missing here takes one. useSyncExternalStore's second is the
  // effect that subscribes to the store. Read only to name them: a list that
  // doesn't add up to the slots there are is not used.
  const SLOTS: Record<string, number> = { useContext: 0, useDebugValue: 0, use: 0, useMemoCache: 0, useTransition: 2, useActionState: 3, useFormState: 3, useSyncExternalStore: 2 };
  /** A hook as inspect shows it: numbered in the order the component calls its hooks, at a slot of React's. */
  type Hook = { index: number; slot: number; kind: string; value?: string; deps?: string; state: boolean };
  const slotsOf = (fiber: Fiber): any[] => {
    const slots: any[] = [];
    for (let hook = fiber.memoizedState; hook && typeof hook === "object" && "next" in hook && "memoizedState" in hook; hook = hook.next) slots.push(hook);
    return slots;
  };
  // Each slot's hook, by the list React keeps in development, with null
  // for the rest of a hook that takes more than one. None when they don't add up.
  const labelsOf = (fiber: Fiber, slots: number): (string | null)[] | null => {
    const labels: (string | null)[] = [];
    for (const type of fiber._debugHookTypes ?? []) {
      const count = SLOTS[type] ?? 1;
      for (let i = 0; i < count; i++) labels.push(i === 0 ? type : null);
    }
    return labels.length === slots ? labels : null;
  };
  // Each slot's hook number and name, or null for the rest of a hook that takes more than one.
  const numbersOf = (fiber: Fiber, slots: number): ({ number: number; label?: string } | null)[] => {
    const labels = labelsOf(fiber, slots);
    let number = 0;
    return Array.from({ length: slots }, (_, slot) => {
      const label = labels?.[slot];
      return label === null ? null : { number: number++, label };
    });
  };
  const hooksOf = (fiber: Fiber): Hook[] => {
    if (fiber.tag === CLASS) return [];
    const slots = slotsOf(fiber);
    const numbers = numbersOf(fiber, slots.length);
    const hooks: Hook[] = [];
    slots.forEach((hook, slot) => {
      const numbered = numbers[slot];
      if (numbered === null || numbered === undefined) return;
      const { number: index, label } = numbered;
      const state = hook.memoizedState;
      const queue = hook.queue;
      if (queue && typeof queue === "object" && ("dispatch" in queue || "getSnapshot" in queue)) {
        const kind = label ?? ("getSnapshot" in queue ? "useSyncExternalStore" : queue.lastRenderedReducer?.name === "basicStateReducer" ? "useState" : "useReducer");
        hooks.push({ index, slot, kind, value: preview(state), state: true });
      } else if (state && typeof state === "object" && "create" in state && "tag" in state) {
        const kind = label ?? (state.tag & 8 ? "useEffect" : state.tag & 4 ? "useLayoutEffect" : "useInsertionEffect");
        hooks.push({ index, slot, kind, deps: state.deps == null ? "none (runs every render)" : preview(state.deps, 1), state: false });
      } else if (Array.isArray(state) && state.length === 2 && (state[1] === null || Array.isArray(state[1]))) {
        const kind = label ?? (typeof state[0] === "function" ? "useCallback" : "useMemo");
        hooks.push({ index, slot, kind, value: preview(state[0]), deps: state[1] === null ? undefined : preview(state[1], 1), state: false });
      } else if (state && typeof state === "object" && Object.keys(state).length === 1 && "current" in state) {
        hooks.push({ index, slot, kind: label ?? "useRef", value: preview(state), state: false });
      } else {
        hooks.push({ index, slot, kind: label ?? "hook", value: preview(state), state: false });
      }
    });
    return hooks;
  };

  // A context made without a displayName is named by the component that provides it.
  const contextNames = new WeakMap<object, string>();
  const contextName = (context: any, fiber: Fiber): string => {
    if (context?.displayName) return context.displayName;
    if (!context || typeof context !== "object") return "Context";
    const known = contextNames.get(context);
    if (known !== undefined) return known;
    for (let at = fiber.return; at; at = at.return) {
      if (at.tag === PROVIDER && (at.type === context || at.type?._context === context)) {
        const owner = ownerOf(at);
        const above = owner?.tag !== undefined ? owner : componentOf(at.return);
        const name = above ? `Context (from ${nameOf(above)})` : "Context";
        contextNames.set(context, name);
        return name;
      }
    }
    return "Context (default value: no provider above)";
  };
  /** A component's hook by the number inspect gives it, or a refusal saying there's none. */
  const hookAt = (fiber: Fiber, number: unknown): Hook => {
    const hook = hooksOf(fiber).find((one) => one.index === number);
    if (hook === undefined) throw refuse(`${nameOf(fiber)} has no hook ${number} (inspect it for its hooks)`);
    return hook;
  };
  // The provider of a context nearest above a fiber, if there is one.
  const providerOf = (context: unknown, fiber: Fiber): Fiber | null => {
    for (let at = fiber.return; at; at = at.return) if (at.tag === PROVIDER && (at.type === context || at.type?._context === context)) return at;
    return null;
  };
  // What a context holds for a fiber: its provider's value, or the context's default with none above.
  const providedValue = (context: any, fiber: Fiber) => {
    const provider = providerOf(context, fiber);
    return provider ? provider.memoizedProps?.value : context?._defaultValue ?? context?._currentValue;
  };
  // What a fiber read of a context: kept with the read from React 18 on, else its provider's value.
  const readValue = (read: any, fiber: Fiber) => ("memoizedValue" in read ? read.memoizedValue : providedValue(read.context, fiber));
  const providerChanged = (context: unknown, fiber: Fiber) => {
    const provider = providerOf(context, fiber);
    return provider?.alternate ? !Object.is(provider.memoizedProps?.value, provider.alternate.memoizedProps?.value) : false;
  };
  const contextsOf = (fiber: Fiber, skip: Set<unknown> = new Set()): [string, string][] => {
    const read: [string, string][] = [];
    // Read once per useContext call: each context is listed once.
    const seen = new Set<unknown>();
    for (let at = fiber.dependencies?.firstContext ?? fiber.contextDependencies?.first; at; at = at.next) {
      if (seen.has(at.context) || skip.has(at.context)) continue;
      seen.add(at.context);
      read.push([contextName(at.context, fiber), preview(readValue(at, fiber))]);
    }
    return read;
  };

  // ---- where it is in the source

  // React 19 keeps the stack of where each element was made, and React 18
  // and earlier its file and line (from the JSX transform). The page's own
  // stacks are of the code it runs, which weblab maps back to the source.
  const madeAt = (fiber: Fiber): string | { fileName: string; lineNumber: number; columnNumber?: number } | null => {
    const stack = fiber._debugStack;
    if (stack) return typeof stack === "string" ? stack : (stack.stack ?? null);
    return fiber._debugSource ?? null;
  };
  // Where a component's own code is: where it made the first element it rendered.
  const definedAt = (fiber: Fiber) => {
    let looked = 0;
    for (const [inside] of walk(fiber)) {
      if (inside !== fiber && (inside._debugOwner === fiber || (fiber.alternate && inside._debugOwner === fiber.alternate))) {
        const made = madeAt(inside);
        if (made !== null) return made;
      }
      if (++looked > 500) break;
    }
    return null;
  };
  // ---- the app's own components, and those from node_modules

  const REACT_OWN = new RegExp(reactOwn);
  const FRAME_FILE = /(?:\(|@|at )([a-z][\w+.-]*:\/\/\S+?|\/[^\s()]+?):\d+:\d+\)?$/i;
  // The file a component's code is in, as the page's own code names it.
  const fileOf = (made: ReturnType<typeof madeAt>): string | null => {
    if (made === null) return null;
    if (typeof made !== "string") return made.fileName ?? null;
    for (const line of made.split("\n")) {
      const file = FRAME_FILE.exec(line.trim())?.[1];
      if (file && !REACT_OWN.test(file)) return file;
    }
    return null;
  };
  const LIBRARY_FILE = /[/\\]node_modules[/\\]/;
  // The package a file in node_modules is from: "@tanstack/react-query". A tool's own folder there
  // (one whose name starts with a dot, holding what it prepared) doesn't say, and its source map does.
  const packageOf = (file: string): string | null => {
    const at = file.lastIndexOf("node_modules/");
    if (at === -1) return null;
    const parts = (file.slice(at + "node_modules/".length).split(/[?#]/)[0] as string).split("/");
    if (parts[0]?.startsWith(".")) return null;
    return (parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]) || null;
  };
  /** The file a component's code is in: from its own frame, else from where it made its first element. */
  //
  // Told first from where the component made its first element, when that
  // stack's frame is the component's own (its name on it). A component
  // that hands on an element made elsewhere (a Slot cloning its child)
  // carries that element's stack, so only then is it called again to see.
  const frameOfFiber = (fiber: Fiber): string | null => {
    const key = typeKey(fiber);
    if (key !== null && frames.has(key)) return frames.get(key) as string | null;
    const made = definedAt(fiber);
    let frame = typeof made === "string" ? ownFrame(made, typeName(fiber.type)) : null;
    if (frame === null) frame = probe(fiber).frame;
    if (frame === null && made !== null) frame = typeof made === "string" ? firstFrame(made) : `at ${typeName(fiber.type)} (${made.fileName}:${made.lineNumber}:${made.columnNumber ?? 1})`;
    if (key !== null) frames.set(key, frame);
    return frame;
  };
  const fileOfFiber = (fiber: Fiber): string | null => fileOf(frameOfFiber(fiber));
  // A stack's first frame past React's: the named function's own, or (firstFrame) whoever's it is.
  const firstFrame = (stack: string): string | null => stack.split("\n").find((line) => {
    const file = FRAME_FILE.exec(line.trim())?.[1];
    return file !== undefined && !REACT_OWN.test(file);
  }) ?? null;
  const ownFrame = (stack: string, name: string): string | null => {
    const frame = firstFrame(stack);
    return frame !== null && frameName(frame) === name ? frame : null;
  };
  /** The package a component from node_modules comes from, when it can be told. */
  const packageOfFiber = (fiber: Fiber): string | null => {
    const key = typeKey(fiber);
    const told = key === null ? undefined : verdicts.get(key);
    if (told !== undefined) return told.from;
    const file = fileOfFiber(fiber);
    return file === null ? null : packageOf(file);
  };
  // The frame each component's code was found at, kept: a component calls back the same
  // way only while it renders the same way (a boundary showing its error doesn't).
  const frames = new WeakMap<object, string | null>();
  // What weblab worked out from a component's source map, where its address can't say
  // (a bundler's chunk): whether it is a library's, and whose.
  const verdicts = new WeakMap<object, { library: boolean; from: string | null }>();
  const typeIds = new Map<number, WeakRef<object>>();
  const typeIdOf = new WeakMap<object, number>();
  const asked = new WeakSet<object>();
  // A root rendered by a production build of React, on a page whose own React is a
  // development build, is tooling's (a framework's dev overlay, an extension), not the app's.
  let toolingRoots = { renderers: -1, roots: new WeakMap<object, boolean>() };
  const toolingRoot = (root: any): boolean => {
    if (!root || typeof root !== "object") return false;
    if (toolingRoots.renderers !== renderers.size) toolingRoots = { renderers: renderers.size, roots: new WeakMap() };
    let answer = toolingRoots.roots.get(root);
    if (answer === undefined) {
      const renderer = renderers.get(rootRenderer.get(root) as number);
      answer = renderer?.bundleType === 0 && [...renderers.values()].some((one) => one.bundleType === 1);
      toolingRoots.roots.set(root, answer);
    }
    return answer;
  };
  /** True for a component from node_modules. A provider or boundary goes with the component that rendered it. */
  const fromLibrary = (fiber: Fiber): boolean => {
    if (toolingRoot(topOf(fiber).stateNode)) return true;
    if (!COMPOSITE.has(fiber.tag)) {
      const owner = ownerOf(fiber);
      return owner?.tag !== undefined && COMPOSITE.has(owner.tag) ? fromLibrary(owner) : false;
    }
    const key = typeKey(fiber);
    const told = key === null ? undefined : verdicts.get(key);
    if (told !== undefined) return told.library;
    // Nothing of its own to tell by: counted as the app's.
    const file = fileOfFiber(fiber);
    return file !== null && LIBRARY_FILE.test(file);
  };
  // The address, line and column of a frame.
  const FRAME_PLACE = /([a-z][\w+.-]*:\/\/\S+?|\/[^\s()]+?):(\d+):(\d+)\)?$/i;

  // ---- custom hooks: which of a component's own hooks each of React's is called in
  //
  // As React DevTools does: the component is called again, outside a
  // render, with a dispatcher that hands back what React holds for each
  // hook in turn and notes the stack of each call. The function names on
  // those stacks between React's hook and the component are its custom hooks.

  const PRIMITIVES = new Set(["use", "useActionState", "useCallback", "useContext", "useDebugValue", "useDeferredValue", "useEffect", "useEffectEvent", "useFormState", "useFormStatus", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo", "useMemoCache", "useOptimistic", "useReducer", "useRef", "useState", "useSyncExternalStore", "useTransition", "useCacheRefresh", "readContext", "useHostTransitionStatus"]);
  // React's own hook, by its name, as a bundler may have renamed it to keep names apart (useState2, useState$1).
  const primitive = (name: string) => PRIMITIVES.has(name) || PRIMITIVES.has(name.replace(/\$?\d+$/, ""));
  const frameName = (line: string): string | null => {
    const name = /^\s*at (?:async )?(?:new )?([^\s(]+)/.exec(line)?.[1] ?? (line.includes("@") ? line.slice(0, line.indexOf("@")) : null);
    if (name === null || name === undefined) return null;
    return name.split(/[.\/<]/).filter(Boolean).at(-1) ?? "";
  };
  type Probe = {
    paths: (string[] | undefined)[] | null;
    frame: string | null;
    /** The custom hooks among the paths whose code is in node_modules. */
    libraryHooks: string[];
    /** The contexts read from inside node_modules (a library's own), not by the component's code. */
    libraryContexts: Set<unknown>;
  };
  /**
   * Calls a function component again to learn two things: for each hook
   * (by the number inspect gives it) the custom hooks it is called in,
   * outermost first, and the component's own frame, from the first time
   * it reads its props or calls a hook, which says where its code is.
   * Without the renderer's dispatcher (React loaded before weblab), only the frame.
   */
  const probe = (fiber: Fiber): Probe => {
    const none: Probe = { paths: null, frame: null, libraryHooks: [], libraryContexts: new Set() };
    if (![FUNCTION, FORWARD_REF, SIMPLE_MEMO, CLASS].includes(fiber.tag)) return none;
    const found = rendererOf(fiber)?.currentDispatcherRef;
    const ref = found && typeof found === "object" ? found : null;
    const slots = slotsOf(fiber);
    let slot = 0;
    const next = () => slots[slot++]?.memoizedState;
    // The real setter of the slot about to be read: whatever the component keeps from this
    // call (a handler on a global, say) has to keep working after it.
    // While weblab calls it, a setter does nothing, as the call must not change the app.
    // Kept and called later, it is React's own.
    let replaying = true;
    const later = (real: unknown) => (typeof real === "function" ? (...args: unknown[]) => (replaying ? undefined : real(...args)) : noop);
    const dispatchOf = () => later(slots[slot]?.queue?.dispatch);
    const calls: { takes: number; stack: string; context?: unknown }[] = [];
    let firstStack: string | null = null;
    const note = (takes: number, context?: unknown) => {
      const stack = new Error().stack ?? "";
      firstStack ??= stack;
      calls.push({ takes, stack, context });
    };
    // What the component read of a context in its last render, else what the context holds outside one.
    const contextValue = (context: any) => {
      for (let at = fiber.dependencies?.firstContext ?? fiber.contextDependencies?.first; at; at = at.next) if (at.context === context) return readValue(at, fiber);
      return providedValue(context, fiber);
    };
    const noop = () => {};
    const STOP = {};
    const effect = () => {
      note(1);
      next();
    };
    const base: Record<string, (...args: any[]) => unknown> = {
      readContext: (context: any) => contextValue(context),
      useContext: (context: any) => (note(0, context), contextValue(context)),
      use: (usable: any) => {
        note(0, usable);
        if (usable && typeof usable.then === "function") {
          if (usable.status === "fulfilled") return usable.value;
          throw STOP;
        }
        return contextValue(usable);
      },
      useState: () => {
        note(1);
        const dispatch = dispatchOf();
        return [next(), dispatch];
      },
      useReducer: () => {
        note(1);
        const dispatch = dispatchOf();
        return [next(), dispatch];
      },
      useRef: () => (note(1), next()),
      useMemo: () => (note(1), (next() as any)?.[0]),
      useCallback: () => (note(1), (next() as any)?.[0]),
      useEffect: effect,
      useLayoutEffect: effect,
      useInsertionEffect: effect,
      useImperativeHandle: effect,
      useDebugValue: noop,
      useDeferredValue: () => (note(1), next()),
      useId: () => (note(1), next()),
      useTransition: () => {
        note(2);
        const pending = next();
        // Its second slot holds the start function itself.
        const start = next();
        return [pending, later(start)];
      },
      useSyncExternalStore: () => {
        note(2);
        const value = next();
        next();
        return value;
      },
      useOptimistic: () => {
        note(1);
        const dispatch = dispatchOf();
        return [next(), dispatch];
      },
      useActionState: () => {
        note(3);
        const state = next();
        next();
        const dispatch = dispatchOf();
        next();
        return [state, dispatch, false];
      },
      useEffectEvent: () => (note(1), next(), noop),
      useCacheRefresh: () => (note(1), next(), noop),
      useMemoCache: (size: number) => Array(size).fill(Symbol.for("react.memo_cache_sentinel")),
      useHostTransitionStatus: () => (note(0), { pending: false, data: null, method: null, action: null }),
      useFormStatus: () => (note(0), { pending: false, data: null, method: null, action: null }),
    };
    base.useFormState = base.useActionState as (...args: any[]) => unknown;
    const fake = new Proxy(base, { get: (target, key) => target[key as string] ?? (() => (note(1), next())) });
    const field = ref === null ? null : "H" in ref ? "H" : "current";
    const before = field === null ? null : ref[field];
    // Its props, as they are, noting where they are first read from.
    const target = fiber.memoizedProps ?? {};
    const reading = () => {
      firstStack ??= new Error().stack ?? "";
    };
    const props = new Proxy(target, {
      get: (object, key) => (reading(), Reflect.get(object, key)),
      has: (object, key) => (reading(), Reflect.has(object, key)),
      ownKeys: (object) => (reading(), Reflect.ownKeys(object)),
    });
    const limit = (Error as any).stackTraceLimit;
    const quiet = ["log", "info", "warn", "error", "debug"] as const;
    const kept = quiet.map((level) => console[level]);
    let rootStack = "";
    function weblabRendersComponent() {
      rootStack = new Error().stack ?? "";
      // A class component's render, on a stand-in for its instance whose props note where they are read.
      if (fiber.tag === CLASS) return fiber.stateNode ? fiber.type.prototype.render.call(Object.create(fiber.stateNode, { props: { value: props } })) : undefined;
      const render = fiber.tag === FORWARD_REF ? fiber.type.render : fiber.type;
      return fiber.tag === FORWARD_REF ? render(props, fiber.ref) : render(props, undefined);
    }
    let finished = false;
    try {
      if (ref !== null && field !== null) ref[field] = fake;
      (Error as any).stackTraceLimit = 60;
      for (const level of quiet) console[level] = noop;
      weblabRendersComponent();
      finished = true;
    } catch (error: any) {
      // Stopped partway (a promise not yet resolved, or the code needing what a real render has): what was noted stands.
      if (ref === null) firstStack ??= typeof error?.stack === "string" ? error.stack : null;
    } finally {
      replaying = false;
      if (ref !== null && field !== null) ref[field] = before;
      (Error as any).stackTraceLimit = limit;
      quiet.forEach((level, i) => (console[level] = kept[i] as any));
    }
    if (!rootStack.includes("weblabRendersComponent")) return none;
    // The component's own frame: the one just above the call weblab made.
    const lines = (firstStack ?? "").split("\n");
    const at = lines.findIndex((line) => line.includes("weblabRendersComponent"));
    const frame = at > 0 ? (lines[at - 1] as string) : null;
    if (ref === null || fiber.tag === CLASS) return { ...none, frame };
    // Every slot accounted for, or the walk stopped early: anything else means the calls didn't line up.
    const taken = calls.reduce((sum, call) => sum + call.takes, 0);
    if (finished ? taken !== slots.length : taken > slots.length) return { ...none, frame };
    const paths: (string[] | undefined)[] = [];
    const libraryHooks = new Set<string>();
    const libraryContexts = new Set<unknown>();
    for (const call of calls) {
      const frames = call.stack
        .split("\n")
        .map((line) => ({ line, name: frameName(line) }))
        .filter((frame): frame is { line: string; name: string } => frame.name !== null && frame.name !== "");
      const at = frames.findIndex((frame) => frame.name === "weblabRendersComponent");
      // Between React's hook and the component: the custom hooks, innermost first.
      // weblab's own frames (this script has no address) and React's are not the app's.
      const between = at < 1 ? [] : frames.slice(0, at - 1).filter((frame) => frame.line.includes("://") && !primitive(frame.name) && !REACT_OWN.test(frame.line));
      const hooks = between.filter((frame) => /^use[A-Z0-9]/.test(frame.name));
      for (const hook of hooks) if (LIBRARY_FILE.test(hook.line)) libraryHooks.add(hook.name);
      if (call.takes === 0) {
        // A context read by code in node_modules (the frame that called it) is the library's business.
        if (call.context !== undefined && between[0] && LIBRARY_FILE.test(between[0].line)) libraryContexts.add(call.context);
        continue;
      }
      paths.push(hooks.map((hook) => hook.name).reverse());
    }
    return { paths, frame, libraryHooks: [...libraryHooks], libraryContexts };
  };

  const ownersOf = (fiber: Fiber): string[] => {
    const owners: string[] = [];
    for (let owner = fiber._debugOwner; owner && owners.length < 12; owner = owner._debugOwner ?? owner.owner) {
      // memo(component, compare) is a fiber of its own above the component, with the same name.
      if (owner.tag === MEMO) continue;
      owners.push(owner.tag !== undefined ? nameOf(owner) : (owner.name ?? "Anonymous"));
    }
    return owners;
  };

  // ---- what rendered, commit by commit

  type Rendered = { name: string; count: number; reasons: Map<string, number>; ms: number; compiled: boolean };
  const compiled = (fiber: Fiber) => fiber?.updateQueue?.memoCache != null;
  let rendered = new Map<number, Rendered>();
  // What unmounted since the last time asked, with the ids of the components it was
  // inside, so a scoped renders can tell whether it was within. Kept as it was in the
  // commit, and told apart (the app's or a library's) only when asked: a commit stays cheap.
  const UNMOUNTS_KEPT = 5000;
  let unmounted: { fiber: Fiber; above: Set<number> }[] = [];
  const gone = (fiber: Fiber, parent: Fiber) => {
    // React has cut a deleted fiber's own `return` by now: its parent, still in the tree, says where it was.
    const above = new Set<number>();
    for (let at = parent; at; at = at.return) if (knownId(at) !== -1) above.add(knownId(at));
    for (const [inside] of walk(fiber)) {
      if (!COMPOSITE.has(inside.tag)) continue;
      renderCounts.delete(knownId(inside));
      if (unmounted.length < UNMOUNTS_KEPT) unmounted.push({ fiber: inside, above });
    }
  };
  let since = { commits: 0, ms: 0 };
  const renderCounts = new Map<number, number>();
  const changedKeys = (before: any, after: any): string[] => {
    if (before === after || before == null || after == null) return [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter((key) => !Object.is(before[key], after[key]));
  };
  // Two values that are different objects with the same contents, a few
  // levels down: a render that changed nothing. Dates are the same when
  // their times are, and functions never are.
  const plain = (value: any) => value !== null && typeof value === "object" && [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value));
  const sameContents = (a: any, b: any, depth = 3): boolean => {
    if (Object.is(a, b)) return true;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (depth === 0) return false;
    if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([key, value]) => b.has(key) && sameContents(value, b.get(key), depth - 1));
    if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((item) => b.has(item));
    if (a && b && ELEMENTS.has(a.$$typeof) && ELEMENTS.has(b.$$typeof)) return a.type === b.type && a.key === b.key && sameContents(a.props, b.props, depth - 1);
    if (!plain(a) || !plain(b) || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameContents(a[key], b[key], depth - 1));
  };
  // Which keys inside two plain objects differ, for a prop or state that is a new object.
  const insideChanged = (a: any, b: any): string => {
    if (a && b && ELEMENTS.has(a.$$typeof) && ELEMENTS.has(b.$$typeof)) {
      if (a.type !== b.type) return " (a different element)";
      const keys = changedKeys(a.props, b.props).filter((key) => !sameContents(a.props[key], b.props[key]));
      return keys.length === 0 ? "" : ` (a <${typeName(b.type)} /> with new ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""})`;
    }
    const inside = changesInside(a, b);
    return inside === "" ? "" : ` (inside: ${inside})`;
  };
  // What changed inside two plain objects: the keys, with a short value's
  // before and after, the keys apps most often branch on first.
  const FIRST = ["status", "data", "error", "isLoading", "isPending", "isFetching", "value"];
  const scalar = (value: unknown) => value === null || ["string", "number", "boolean", "undefined", "bigint"].includes(typeof value);
  const changesInside = (a: any, b: any): string => {
    if (!plain(a) || !plain(b) || Array.isArray(a) || Array.isArray(b)) return "";
    const keys = changedKeys(a, b)
      .filter((key) => !sameContents(a[key], b[key]))
      .sort((x, y) => (FIRST.includes(x) ? FIRST.indexOf(x) : FIRST.length) - (FIRST.includes(y) ? FIRST.indexOf(y) : FIRST.length));
    const told = keys.slice(0, 4).map((key) => (secret(key, a[key]) || secret(key, b[key]) ? `${key} [redacted]` : scalar(a[key]) && scalar(b[key]) ? `${key} ${short(a[key])} → ${short(b[key])}` : key));
    return keys.length === 0 ? "" : `${told.join(", ")}${keys.length > 4 ? `, …${keys.length - 4} more` : ""}`;
  };
  const short = (value: unknown) => {
    const text = preview(value, 0);
    return text.length > 30 ? `${text.slice(0, 29)}…` : text;
  };
  const why = (next: Fiber, prev: Fiber): string[] => {
    const reasons: string[] = [];
    // Props that are new but the same inside are told apart from real changes.
    const changedProps = changedKeys(prev.memoizedProps, next.memoizedProps);
    const equal = changedProps.filter((key) => sameContents(prev.memoizedProps[key], next.memoizedProps[key]));
    const props = changedProps.filter((key) => !equal.includes(key)).map((key) => `${key}${insideChanged(prev.memoizedProps[key], next.memoizedProps[key])}`);
    if (props.length > 0) reasons.push(`props changed: ${props.join(", ")}`);
    if (equal.length > 0) reasons.push(`props new but equal: ${equal.join(", ")}`);
    if (next.tag === CLASS) {
      const state = changedKeys(prev.memoizedState, next.memoizedState);
      if (state.length > 0) reasons.push(`state changed: ${state.join(", ")}`);
    } else {
      const changed: [slot: number, before: unknown, after: unknown][] = [];
      for (let a = prev.memoizedState, b = next.memoizedState, i = 0; a && b && typeof a === "object" && "next" in a; a = a.next, b = b.next, i++) {
        if (b.queue && !Object.is(a.memoizedState, b.memoizedState)) changed.push([i, a.memoizedState, b.memoizedState]);
      }
      if (changed.length > 0) {
        const numbers = numbersOf(next, slotsOf(next).length);
        const told = changed.map(([slot, before, after]) => {
          const numbered = numbers[slot];
          const name = numbered ? `hook ${numbered.number}${numbered.label ? ` (${numbered.label})` : ""}` : `hook slot ${slot}`;
          if (sameContents(before, after)) return `${name} new but equal`;
          // An object's state says what changed inside it, rather than {…} → {…}.
          const inside = changesInside(before, after);
          return inside !== "" ? `${name}: ${inside}` : `${name} ${short(before)} → ${short(after)}`;
        });
        reasons.push(`state changed: ${told.join(", ")}`);
      }
    }
    const contexts = new Map<unknown, string>();
    for (let a = prev.dependencies?.firstContext, b = next.dependencies?.firstContext; a && b; a = a.next, b = b.next) {
      // Before React 18 a read isn't kept: its provider's value against what the provider had before says.
      const changed = "memoizedValue" in b ? !Object.is(a.memoizedValue, b.memoizedValue) : providerChanged(b.context, next);
      if (changed) contexts.set(b.context, contextName(b.context, next));
    }
    if (contexts.size > 0) reasons.push(`context changed: ${[...contexts.values()].join(", ")}`);
    if (reasons.length === 0) {
      const owner = ownerOf(next);
      // A compiled component keeps the elements it makes, and makes one again only when what it was made from changed.
      const remade = owner?.tag !== undefined && compiled(owner) ? `, but compiled ${nameOf(owner)} made this element again, so something it was made from changed` : "";
      reasons.push(prev.memoizedProps !== next.memoizedProps ? `parent rendered (props equal${remade})` : "rendered (nothing it reads changed)");
    }
    return reasons;
  };
  const ROWS_KEPT = 20000;
  const note = (fiber: Fiber, reasons: string[]) => {
    const id = idOf(fiber);
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    let entry = rendered.get(id);
    // Past this many components between asks, only their counts since the page loaded are kept.
    if (entry === undefined && rendered.size >= ROWS_KEPT) return;
    if (entry === undefined) rendered.set(id, (entry = { name: nameOf(fiber), count: 0, reasons: new Map(), ms: 0, compiled: compiled(fiber) }));
    entry.count += 1;
    // How many of its renders had each reason: a few kinds kept, and the rest counted together.
    for (const reason of reasons) {
      const kept = entry.reasons.has(reason) || entry.reasons.size < 5 ? reason : "other reasons";
      entry.reasons.set(kept, (entry.reasons.get(kept) ?? 0) + 1);
    }
    if (typeof fiber.selfBaseDuration === "number") entry.ms += fiber.selfBaseDuration;
  };
  // Like DevTools: down the paths that changed, comparing each fiber with
  // the one it replaced. A child list the same as before was skipped whole.
  const track = (next: Fiber, prev: Fiber | null) => {
    if (COMPOSITE.has(next.tag)) {
      if (prev === null) note(next, ["mounted"]);
      else if ((next.flags ?? next.effectTag) & PERFORMED_WORK) note(next, why(next, prev));
    }
    if (prev === null) {
      for (let child = next.child; child; child = child.sibling) track(child, null);
      return;
    }
    if (next.child === prev.child) return;
    const now = new Set<Fiber>();
    for (let child = next.child; child; child = child.sibling) {
      now.add(child);
      if (child.alternate) now.add(child.alternate);
      track(child, child.alternate);
    }
    // A child the fiber had before and has no more: unmounted, with all inside it.
    for (let child = prev.child; child; child = child.sibling) if (!now.has(child)) gone(child, next);
  };
  const onCommit = (renderer: number, root: any) => {
    if (detached) return;
    commits += 1;
    roots.add(root);
    rootRenderer.set(root, renderer);
    if (!root.current?.child) roots.delete(root);
    else everRendered = true;
    since.commits += 1;
    if (typeof root.current?.actualDuration === "number") since.ms += root.current.actualDuration;
    track(root.current, root.current.alternate?.child ? root.current.alternate : null);
  };

  // ---- the hook

  // What weblab replaced on a hook it joined, to put back when it leaves.
  let joined: { hook: any; inject: unknown; onCommitFiberRoot: unknown } | null = null;
  let detached = false;
  const join = (hook: any) => {
    if (hook.__weblab) return;
    hook.__weblab = true;
    joined = { hook, inject: hook.inject, onCommitFiberRoot: hook.onCommitFiberRoot };
    watching = early ? "start" : "late";
    hook.renderers?.forEach?.((renderer: Renderer, id: number) => renderers.set(id, renderer));
    const inject = typeof hook.inject === "function" ? hook.inject : () => -1;
    hook.inject = function (this: any, renderer: Renderer) {
      const id = inject.call(this, renderer);
      renderers.set(id, renderer);
      return id;
    };
    const onCommitFiberRoot = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (this: any, renderer: number, root: any, ...rest: any[]) {
      try {
        onCommit(renderer, root);
      } catch {
        // What weblab sees must never break the app.
      }
      return onCommitFiberRoot?.call(this, renderer, root, ...rest);
    };
  };
  const existing = page.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing && typeof existing === "object") join(existing);
  else if (early) {
    let next = 1;
    const listeners: Record<string, Function[]> = {};
    const hook = {
      renderers: new Map<number, Renderer>(),
      supportsFiber: true,
      inject(renderer: Renderer) {
        const id = next++;
        hook.renderers.set(id, renderer);
        return id;
      },
      onCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onScheduleFiberRoot() {},
      setStrictMode() {},
      checkDCE() {},
      // What DevTools' own hook also has, which some libraries reach for.
      on(event: string, listener: Function) {
        (listeners[event] ??= []).push(listener);
      },
      off(event: string, listener: Function) {
        listeners[event] = (listeners[event] ?? []).filter((one) => one !== listener);
      },
      emit(event: string, data: unknown) {
        for (const listener of listeners[event] ?? []) listener(data);
      },
      sub(event: string, listener: Function) {
        hook.on(event, listener);
        return () => hook.off(event, listener);
      },
    };
    Object.defineProperty(page, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true, writable: true, enumerable: false });
    join(hook);
  }

  // ---- what the react step asks for

  const rendererOf = (fiber: Fiber): Renderer | null => {
    const id = rootRenderer.get(topOf(fiber).stateNode);
    const renderer = id === undefined ? [...renderers.values()].find((one) => typeof one.overrideProps === "function") : renderers.get(id);
    return renderer ?? null;
  };
  const changer = (fiber: Fiber, method: string): Renderer => {
    const renderer = rendererOf(fiber);
    if (renderer && typeof renderer[method] === "function") return renderer;
    if (renderers.size === 0) {
      throw new Error(`React loaded before weblab's hook was in the page, so it can't be changed from here. Reload the page, and weblab's hook goes in before React from then on`);
    }
    if (renderer && typeof renderer.overrideProps === "function") {
      const version = renderer.reconcilerVersion ?? renderer.version ?? "this version";
      throw new Error(`React ${version} can't do this from outside (React 18 and later can)`);
    }
    throw new Error(`this React can't be changed from outside: it is a production build (a development build can)`);
  };
  const notOnPage = () => {
    if (allRoots().length > 0) return null;
    if (everRendered) return "React's tree is unmounted: nothing is rendered with it now (React unmounts its tree when an app throws while rendering, which the console would show)";
    return renderers.size > 0 ? "React is loaded, but nothing is rendered with it yet" : "no React on this page (no React root was found)";
  };

  // Props worth a glance in a tree: a few short plain ones.
  const glance = (fiber: Fiber): string => {
    const bits: string[] = [];
    if (fiber.key != null) bits.push(`key=${JSON.stringify(fiber.key)}`);
    if (fiber.tag === PROVIDER) bits.push(`value=${preview(fiber.memoizedProps?.value, 0)}`);
    else if (fiber.tag === SUSPENSE && fiber.memoizedState !== null) bits.push("(showing its fallback)");
    else bits.push(...propBits(fiber.memoizedProps));
    return bits.length > 0 ? ` ${bits.join(" ")}` : "";
  };
  const propBits = (props: any): string[] => {
    const bits: string[] = [];
    for (const [key, value] of Object.entries(props ?? {})) {
      if (key === "children" || bits.length >= 5) continue;
      if (typeof value === "string") bits.push(`${key}=${kept(key, value, () => JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}…` : value))}`);
      else if (typeof value === "number" || typeof value === "boolean") bits.push(`${key}=${value}`);
    }
    return bits;
  };

  // ---- server components
  //
  // A server component runs on the server, so the page has no fiber of it,
  // only what it rendered. React's development build notes it on those
  // fibers (_debugInfo): its name, props, owner and stack.
  type ServerInfo = { name: string; env?: string; key?: string | null; props?: any; owner?: ServerInfo | null; debugStack?: any; stack?: any };
  const serverInfos = (fiber: Fiber): ServerInfo[] => (fiber._debugInfo ?? []).filter((info: any) => info && typeof info.name === "string" && info.env !== undefined);
  const serverNames = () => {
    const names = new Set<string>();
    for (const [fiber] of walk()) for (const info of serverInfos(fiber)) names.add(info.name);
    return names;
  };
  const serverStack = (info: ServerInfo): string => String(info.debugStack?.stack ?? info.debugStack ?? info.stack ?? "");
  // A server component's own stack is where it was made, in its owner's code. Its
  // own code is where it made what it rendered: the stack of an element it owns,
  // a server component's or a client one's, at a frame with its name.
  // Gathered in one walk, until React commits again: each server component's frame in its own code.
  let serverIndex: { frames: Map<ServerInfo, string>; commits: number; at: number } | null = null;
  const serverCodeFrame = (info: ServerInfo): string | null => {
    if (!fresh(serverIndex)) {
      const frames = new Map<ServerInfo, string>();
      const consider = (owner: unknown, stack: unknown) => {
        if (!owner || typeof owner !== "object" || "tag" in owner || frames.has(owner as ServerInfo) || typeof stack !== "string") return;
        const first = firstFrame(stack);
        if (first !== null && frameName(first) === (owner as ServerInfo).name) frames.set(owner as ServerInfo, first);
      };
      for (const [fiber] of walk()) {
        consider(fiber._debugOwner, fiber._debugStack?.stack ?? fiber._debugStack);
        for (const inner of serverInfos(fiber)) consider(inner.owner, serverStack(inner));
      }
      serverIndex = { frames, commits, at: performance.now() };
    }
    return (serverIndex as { frames: Map<ServerInfo, string> }).frames.get(info) ?? null;
  };
  // Whether a server component is a library's, by the file its code is in, as weblab looked it up.
  const serverVerdicts = new Map<string, { library: boolean; from: string | null }>();
  const serverAsked = new Set<string>();
  const serverVerdict = (info: ServerInfo) => {
    const place = FRAME_PLACE.exec((serverCodeFrame(info) ?? "").trim());
    return place ? serverVerdicts.get(place[1] as string) : undefined;
  };
  const shown = (fiber: Fiber) => COMPOSITE.has(fiber.tag) || fiber.tag === SUSPENSE || fiber.tag === PROVIDER || fiber.tag === ACTIVITY;

  const forcedSuspense = new Set<number>();
  const forcedErrors = new Map<number, boolean>();
  const nearest = (fiber: Fiber, holds: (fiber: Fiber) => boolean, what: string): Fiber => {
    for (let at = fiber; at; at = at.return) if (holds(at)) return current(at) ?? at;
    throw refuse(`${nameOf(fiber)} has no ${what} around it`);
  };
  const isBoundary = (fiber: Fiber) =>
    fiber.tag === CLASS && (typeof fiber.type?.getDerivedStateFromError === "function" || typeof fiber.type?.prototype?.componentDidCatch === "function");
  // A copy of a value with what is at a path in it replaced, as React's own overrides make.
  const withSet = (value: any, path: (string | number)[], to: unknown): any => {
    if (path.length === 0) return to;
    const [key, ...rest] = path as [string | number, ...(string | number)[]];
    const copy = Array.isArray(value) ? [...value] : { ...value };
    copy[key as any] = withSet(value?.[key], rest, to);
    return copy;
  };
  const pause = () => new Promise((done) => setTimeout(done, 50));
  // Boundaries let go of: rendered again, and named as they were.
  const release = async (released: number[]) => {
    for (const id of released) {
      const now = byIdNow(id);
      if (now) changer(now, "scheduleUpdate").scheduleUpdate(now);
    }
    await pause();
    return released.map((id) => {
      const fiber = byId.get(id)?.deref();
      return fiber ? label(fiber) : `c${id}`;
    });
  };
  // Waits for React to render what was changed, and says if that made the app throw.
  const settle = async (fiber: Fiber, what: string) => {
    const top = topOf(fiber);
    const thrown: string[] = [];
    let caught: string | null = null;
    const listen = (event: ErrorEvent) => thrown.push(String(event.error?.message ?? event.message));
    // An error a boundary caught isn't thrown on: React logs it.
    const log = console.error;
    // React says which boundary caught an error ("The above error occurred in the <X> component"). The app's own logging isn't that.
    console.error = (...args: unknown[]) => {
      const told = args.some((arg) => typeof arg === "string" && arg.includes("The above error occurred in"));
      const error = args.find((arg) => arg instanceof Error) as Error | undefined;
      if (told && !/Simulated error coming from DevTools/.test(error?.message ?? "")) caught ??= error?.message ?? "an error";
      return log.apply(console, args as []);
    };
    addEventListener("error", listen);
    try {
      await pause();
    } finally {
      removeEventListener("error", listen);
      console.error = log;
    }
    if (thrown.length === 0 && caught === null) return;
    if (thrown.length === 0) throw new Error(`${what}, but rendering then threw: ${caught}, and an error boundary caught it and shows its error state now`);
    const gone = top.tag === ROOT && !top.stateNode.current?.child;
    throw new Error(`${what}, but rendering then threw: ${thrown[0]}${gone ? ". React unmounted the whole tree, so reload the page to go on" : ""}`);
  };

  const react = {
    /** How many commits React has made since the page loaded (or since weblab began watching). */
    get commits() {
      return commits;
    },
    /** The components with that name, or with that id (c12): each as { id, name, key, props, state }. */
    find(name: string) {
      const fibers = fibersFor(name);
      return fibers.map(summary);
    },
    /** The component that rendered an element, as find gives one. */
    of(element: Node) {
      return summary(resolve(element));
    },
    /** Sets a component's prop, hook (by number) or class state, at a path: what the react step's set does, with any value code can make. */
    set(target: unknown, what: "prop" | "hook" | "state", path: string | number | (string | number)[], value: unknown) {
      const parts = Array.isArray(path) ? path : typeof path === "string" ? path.split(".").map((part, i) => (what === "hook" && i === 0 ? Number(part) : part)) : [path];
      return react._set(`c${idOf(resolve(target))}`, what, parts, value);
    },
    /** The fiber itself, as it now stands: for code that wants to read React's own data. */
    fiber(target: unknown, nth = 0) {
      return resolve(target, nth);
    },

    /** Leaves the page as weblab found it: the hook it joined as it was, forced boundaries let go, and no weblab.react. */
    async _detach() {
      if (forcedSuspense.size > 0 || forcedErrors.size > 0) {
        const suspended = [...forcedSuspense];
        forcedSuspense.clear();
        const errors = [...forcedErrors.keys()];
        for (const id of errors) forcedErrors.set(id, false);
        await release([...suspended, ...errors]).catch(() => {});
      }
      detached = true;
      if (joined !== null) {
        Object.assign(joined.hook, { inject: joined.inject, onCommitFiberRoot: joined.onCommitFiberRoot });
        delete joined.hook.__weblab;
      }
      delete page.weblab.react;
      if (Object.keys(page.weblab).length === 0) delete page.weblab;
    },
    // What the react step and the component target read.
    /** Runs one of the calls below for the step. What a refusal says comes back as data, with any names near what was asked for, and a failure is thrown. */
    async _run(call: string, args: unknown[]) {
      try {
        return { value: await (react as any)[call](...args) };
      } catch (error: any) {
        if (error?.name !== "WeblabRefused") throw error;
        return { refused: String(error.message), names: (error.names as string[] | undefined) ?? [] };
      }
    },
    /** True when every React on the page is a production build: names minified, no source locations, nothing to change. */
    _production() {
      return renderers.size > 0 && [...renderers.values()].every((one) => one.bundleType === 0);
    },
    /** Kinds of component on the page whose code's address doesn't say whose they are, with where their code is, for weblab to look up. */
    _unclassified() {
      const out: { id: number; file: string; line: number; column: number }[] = [];
      for (const [fiber] of walk()) {
        if (!COMPOSITE.has(fiber.tag) || out.length >= 500) continue;
        const key = typeKey(fiber);
        if (key === null || verdicts.has(key) || asked.has(key)) continue;
        asked.add(key);
        const place = FRAME_PLACE.exec((frameOfFiber(fiber) ?? "").trim());
        if (!place) continue;
        // In node_modules by its address: a library's, and only its package left to look up, when the address doesn't say.
        if (LIBRARY_FILE.test(place[1] as string)) {
          const from = packageOf(place[1] as string);
          verdicts.set(key, { library: true, from });
          if (from !== null) continue;
        }
        let id = typeIdOf.get(key);
        if (id === undefined) {
          id = typeIds.size + 1;
          typeIds.set(id, new WeakRef(key));
          typeIdOf.set(key, id);
        }
        out.push({ id, file: place[1] as string, line: Number(place[2]), column: Number(place[3]) });
      }
      for (const [fiber] of walk()) {
        for (const info of serverInfos(fiber)) {
          if (out.length >= 500) break;
          const place = FRAME_PLACE.exec((serverCodeFrame(info) ?? "").trim());
          const file = place?.[1] as string | undefined;
          if (!place || file === undefined || serverVerdicts.has(file) || serverAsked.has(file)) continue;
          serverAsked.add(file);
          // In node_modules by its address: a library's, as a client component is.
          if (LIBRARY_FILE.test(file)) {
            const from = packageOf(file);
            serverVerdicts.set(file, { library: true, from });
            if (from !== null) continue;
          }
          out.push({ id: -serverAsked.size, server: file, file, line: Number(place[2]), column: Number(place[3]) } as any);
        }
      }
      return out;
    },
    /** What weblab found in the source maps: for each kind, whether it is a library's, and which package. */
    _classify(found: [number, boolean, string | null][]) {
      for (const [id, library, from, server] of found as [number, boolean, string | null, string?][]) {
        if (server !== undefined) {
          serverVerdicts.set(server, { library, from });
          continue;
        }
        const key = typeIds.get(id)?.deref();
        if (key) verdicts.set(key, { library, from });
      }
    },
    _resolve(target: unknown, nth = 0) {
      return `c${idOf(resolve(target, nth))}`;
    },
    /** The component that rendered an element: the nearest of the app's own, and the library one inside it that did, if that is who. */
    _resolveElement(node: Node, library: boolean) {
      const nearestOne = resolve(node);
      if (library || !fromLibrary(nearestOne)) return { id: `c${idOf(nearestOne)}`, via: null };
      for (let at = nearestOne.return; at; at = at.return) {
        if (COMPOSITE.has(at.tag) && !fromLibrary(at)) {
          const own = current(at) ?? at;
          return { id: `c${idOf(own)}`, via: { id: `c${idOf(nearestOne)}`, name: nameOf(nearestOne), from: packageOfFiber(nearestOne) } };
        }
      }
      return { id: `c${idOf(nearestOne)}`, via: null };
    },
    /** The component whose code wrote an element, when it isn't the one rendering it (a wrapper that passes on children). */
    _writer(node: Node) {
      const host = fiberOfNode(node);
      const inside = componentOf(host);
      const owner = ownerOf(host);
      if (!owner || owner.tag === undefined || !COMPOSITE.has(owner.tag) || (inside && (owner === inside || owner === inside.alternate))) return null;
      const now = current(owner) ?? owner;
      return { element: describeNode(node), id: `c${idOf(now)}`, name: nameOf(now), made: madeAt(host) };
    },
    _elements(selector: string, root: Node): Element[] {
      const fibers = fibersFor(selector);
      const firsts = fibers.map((fiber) => hostsOf(fiber)[0]);
      // On the page but with nothing of its own to act on: waiting won't change that.
      if (fibers.length > 0 && firsts.every((element) => element === undefined)) {
        throw new Error(`${selector} renders no element of its own to act on. Target an element inside it, or inspect it`);
      }
      return firsts.filter((element): element is Element => element !== undefined && root.contains(element));
    },
    _tree(under: string | null, depth: number | null, limit: number, library: boolean) {
      const missing = notOnPage();
      if (missing !== null) throw new Error(missing);
      const lines: string[] = [];
      let more = 0;
      let hidden = 0;
      // A tooling root is left out whole, unless libraries are asked for.
      const shownRoots = allRoots().filter((root) => {
        if (library || !toolingRoot(root)) return true;
        if (under === null) for (const [fiber] of walk(root.current)) if (shown(fiber)) hidden += 1;
        return false;
      });
      const starts = under === null ? shownRoots.map((root) => root.current) : [resolve(under)];
      for (const start of starts) {
        if (under === null) lines.push(`- root ${describeNode(start.stateNode?.containerInfo)}`);
        // How deep among the components shown each fiber is: under the
        // root line from 1, or from 0 for a component asked for.
        const levels = new Map<Fiber, number>();
        const servers = new Map<ServerInfo, number>();
        const base = under === null ? 0 : -1;
        for (const [fiber, parent] of walk(start)) {
          let above = parent === null ? base : (levels.get(parent) as number);
          // The server components that rendered this, each once, under the one that rendered it.
          // A tree asked for from a component starts at it, not at the server components above it.
          for (const info of fiber === start && under !== null ? [] : serverInfos(fiber)) {
            const placed = servers.get(info);
            if (placed !== undefined) {
              above = placed;
              continue;
            }
            if (serverVerdict(info)?.library && !library) {
              // Counted once, and what it rendered shown where it would have been.
              servers.set(info, above);
              hidden += 1;
              continue;
            }
            const level = info.owner && servers.has(info.owner) ? (servers.get(info.owner) as number) + 1 : above + 1;
            servers.set(info, level);
            above = level;
            if (depth !== null && level > depth) continue;
            if (lines.length >= limit) more += 1;
            else lines.push(`${"  ".repeat(level)}- ${info.name} (server)${info.key != null ? ` key=${JSON.stringify(info.key)}` : ""}${(() => {
              const bits = propBits(info.props);
              return bits.length > 0 ? ` ${bits.join(" ")}` : "";
            })()}`);
          }
          // Components from node_modules are left out unless asked for, and what they render is shown under the nearest shown above.
          const hide = shown(fiber) && !library && fiber !== start && fromLibrary(fiber);
          if (hide) hidden += 1;
          const show = shown(fiber) && !hide;
          const level = show ? above + 1 : above;
          levels.set(fiber, level);
          // A depth counts the levels under the root line, or under the component asked for.
          if (!show || (depth !== null && level > depth)) continue;
          if (lines.length >= limit) {
            more += 1;
            continue;
          }
          lines.push(`${"  ".repeat(level)}- ${nameOf(fiber)}${glance(fiber)} [c${idOf(fiber)}]`);
        }
      }
      return { lines, more, hidden };
    },
    _inspect(target: string, library: boolean) {
      const fiber = resolve(target);
      const probed = probe(fiber);
      const hosts = hostsOf(fiber);
      const props = Object.entries(fiber.memoizedProps ?? {}).map(([key, value]): [string, string] => [key, kept(key, value, () => preview(value))]);
      const state =
        fiber.tag === CLASS && fiber.memoizedState && typeof fiber.memoizedState === "object"
          ? Object.entries(fiber.memoizedState).map(([key, value]): [string, string] => [key, kept(key, value, () => preview(value))])
          : [];
      return {
        id: `c${idOf(fiber)}`,
        name: nameOf(fiber),
        kind: fiber.tag === MEMO || fiber.return?.tag === MEMO ? `memo ${kindOf(fiber)}` : kindOf(fiber),
        key: fiber.key,
        props,
        state,
        hooks: collapsed(fiber, hooksOf(fiber).map((hook) => ({ ...hook, path: probed.paths?.[hook.index] ?? [] })), library ? [] : probed.libraryHooks),
        compiled: compiled(fiber),
        contexts: contextsOf(fiber, library ? new Set() : probed.libraryContexts),
        owners: ownersOf(fiber),
        server: (fiber._debugInfo ?? []).map((info: any) => info?.name).filter(Boolean),
        // Under memo(component, compare), the element was made for the memo, above.
        usedAt: (fiber.return?.tag === MEMO ? madeAt(fiber.return) : null) ?? madeAt(fiber),
        // Where its code is: its own frame, else where it made its first element.
        definedAt: probed.frame ?? definedAt(fiber),
        elements: hosts.slice(0, 5).map(describeNode),
        elementCount: hosts.length,
        renders: renderCounts.get(idOf(fiber)) ?? null,
        boundary: isBoundary(fiber),
        suspended: fiber.tag === SUSPENSE ? fiber.memoizedState !== null : null,
        watching,
        changeable: renderers.size > 0,
      };
    },
    _renders(library: boolean, under: string | null, keep: boolean) {
      const probes = new Map<unknown, Probe>();
      const probed = (fiber: Fiber) => {
        if (!probes.has(fiber.type)) probes.set(fiber.type, probe(current(fiber) ?? fiber));
        return probes.get(fiber.type) as Probe;
      };
      // "hook 4 (useState)" says which custom hook it is in, "hook 4 (usePlayer › useState)",
      // and in a library's hook only as far as the library's: "hook 4 (useQuery)".
      const named = (fiber: Fiber | undefined, reason: string) => {
        if (!fiber || !reason.startsWith("state changed:")) return reason;
        const { paths, libraryHooks } = probed(fiber);
        if (!paths) return reason;
        return reason.replace(/hook (\d+) \((\w+)\)/g, (whole, number, kind) => {
          const path = paths[Number(number)];
          if (!path?.length) return whole;
          const cut = library ? -1 : path.findIndex((hook) => libraryHooks.includes(hook));
          return `hook ${number} (${cut === -1 ? [...path, kind].join(" › ") : path.slice(0, cut + 1).join(" › ")})`;
        });
      };
      // Within one component, when asked: it and everything under it.
      const scope = under === null ? null : Number(under.slice(1));
      const within = (fiber: Fiber | undefined) => {
        if (scope === null) return true;
        for (let at = fiber; at; at = at.return) if (knownId(at) === scope) return true;
        return false;
      };
      const rows = [];
      let hiddenRows = 0;
      let hiddenRenders = 0;
      const told: number[] = [];
      for (const [id, entry] of rendered) {
        const fiber = byId.get(id)?.deref();
        if (!within(fiber)) continue;
        told.push(id);
        if (!library && fiber && fromLibrary(fiber)) {
          hiddenRows += 1;
          hiddenRenders += entry.count;
          continue;
        }
        rows.push({ id: `c${id}`, name: entry.name, count: entry.count, compiled: entry.compiled, reasons: [...entry.reasons].map(([reason, times]): [string, number] => [named(fiber, reason), times]), ms: entry.ms });
      }
      const counts = new Map<string, number>();
      for (const one of unmounted) {
        if ((scope === null || one.above.has(scope)) && (library || !fromLibrary(one.fiber))) counts.set(nameOf(one.fiber), (counts.get(nameOf(one.fiber)) ?? 0) + 1);
      }
      const result = { ...since, rows, hidden: { components: hiddenRows, renders: hiddenRenders }, unmounted: [...counts].map(([name, count]) => ({ name, count })), watching };
      // Asked about one component, only what is within it is cleared. Asked about all, everything is.
      if (!keep && scope === null) {
        rendered = new Map();
        unmounted = [];
        since = { commits: 0, ms: 0 };
      } else if (!keep) {
        for (const id of told) rendered.delete(id);
        unmounted = unmounted.filter((one) => !one.above.has(scope as number));
      }
      return result;
    },
    /** One value of a component in full: a prop, a hook (by number) or class state, and a path inside it. */
    _value(target: string, what: "prop" | "hook" | "state", path: (string | number)[]) {
      const fiber = resolve(target);
      let value: any;
      let rest = path;
      if (what === "hook") {
        const [number, ...inside] = path;
        const hook = hookAt(fiber, number);
        const slot = slotState(fiber, hook.slot);
        value = hook.kind === "useMemo" || hook.kind === "useCallback" ? slot?.[0] : hook.deps !== undefined && slot && typeof slot === "object" && "create" in slot ? { deps: slot.deps } : slot;
        rest = inside;
      } else if (what === "state" && fiber.tag !== CLASS) {
        throw refuse(`${nameOf(fiber)} is a function component, whose state is in its hooks: give hook, with the number inspect gives one`);
      } else value = what === "prop" ? fiber.memoizedProps : fiber.memoizedState;
      for (const [i, key] of rest.entries()) {
        const where = [what === "hook" ? path[0] : null, ...rest.slice(0, i)].filter((part) => part !== null).join(".") || what;
        const has = value instanceof Map ? value.has(key) : value !== null && typeof value === "object" ? key in value : false;
        if (!has) {
          const keys = value instanceof Map ? [...value.keys()].map(String) : value !== null && typeof value === "object" ? Object.keys(value) : [];
          throw refuse(`${where} of ${nameOf(fiber)} has no ${key}${keys.length > 0 ? ` (it has ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""})` : `: it is ${preview(value, 0)}`}`);
        }
        value = value instanceof Map ? value.get(key) : value[key as any];
      }
      // A value under a name that holds a secret stays hidden here too.
      const last = rest.at(-1) ?? (what === "hook" ? undefined : path.at(-1));
      return `${label(fiber)} ${what} ${path.join(".")}${secret(last, value) ? " [redacted]" : expand(value, 4, "")}`;
    },
    async _set(target: string, what: "prop" | "hook" | "state", path: (string | number)[], value: unknown) {
      const fiber = resolve(target);
      if (what === "prop") {
        changer(fiber, "overrideProps").overrideProps(fiber, path, value);
      } else if (what === "hook") {
        const [index, ...rest] = path;
        const hook = hookAt(fiber, index);
        if (hook.kind === "useSyncExternalStore") throw refuse(`hook ${index} of ${nameOf(fiber)} is a useSyncExternalStore, whose store decides its value: change the store instead (a js step)`);
        if (!hook.state || !["useState", "useReducer"].includes(hook.kind)) throw refuse(`hook ${index} of ${nameOf(fiber)} is a ${hook.kind}, which holds no state to set. Only useState and useReducer hooks can be set`);
        changer(fiber, "overrideHookState").overrideHookState(fiber, hook.slot, rest, value);
      } else {
        const instance = fiber.stateNode;
        if (fiber.tag !== CLASS || !instance) throw refuse(`${nameOf(fiber)} is a function component: change one of its hooks instead`);
        const [key, ...rest] = path as string[];
        instance.setState({ [key as string]: withSet(instance.state?.[key as string], rest, value) });
      }
      await settle(fiber, `${what} ${path.join(".")} of ${nameOf(fiber)} was set`);
      return label(fiber);
    },
    async _suspend(target: string | false) {
      if (target === false) {
        const released = [...forcedSuspense];
        forcedSuspense.clear();
        return release(released);
      }
      const boundary = nearest(resolve(target), (fiber) => fiber.tag === SUSPENSE, "Suspense boundary");
      const renderer = changer(boundary, "setSuspenseHandler");
      forcedSuspense.add(idOf(boundary));
      renderer.setSuspenseHandler((fiber: Fiber) => forcedSuspense.has(knownId(fiber)));
      renderer.scheduleUpdate(boundary);
      await settle(boundary, `the Suspense boundary was forced to its fallback`);
      return [described(boundary)];
    },
    async _error(target: string | false) {
      if (target === false) {
        const released = [...forcedErrors.keys()];
        for (const id of released) forcedErrors.set(id, false);
        return release(released);
      }
      const boundary = nearest(resolve(target), isBoundary, "error boundary (a class component with getDerivedStateFromError or componentDidCatch)");
      const renderer = changer(boundary, "setErrorHandler");
      forcedErrors.set(idOf(boundary), true);
      renderer.setErrorHandler((fiber: Fiber) => {
        const id = knownId(fiber);
        if (!forcedErrors.has(id)) return null;
        const forced = forcedErrors.get(id) as boolean;
        // Let go of once it has been told to recover.
        if (!forced) forcedErrors.delete(id);
        return forced;
      });
      renderer.scheduleUpdate(boundary);
      await settle(boundary, `the error boundary was forced to its error state`);
      return [described(boundary)];
    },
  };
  // A library's custom hook as one line: its hooks are its business. What it
  // holds is told by the last of its state, a query's key, and how many hooks it has.
  type Shown = Hook & { path: string[]; count?: number; group?: string[] };

  const brief = (value: any) => {
    if (value === null || typeof value !== "object" || !FIRST.some((key) => key in value)) return preview(value, 1);
    return `{ ${FIRST.filter((key) => key in value).slice(0, 3).map((key) => `${key}: ${preview(value[key], 0)}`).join(", ")} }`;
  };
  const collapsed = (fiber: Fiber, hooks: Shown[], libraryHooks: string[]): Shown[] => {
    if (libraryHooks.length === 0) return hooks;
    const out: Shown[] = [];
    for (const hook of hooks) {
      const cut = hook.path.findIndex((name) => libraryHooks.includes(name));
      if (cut === -1) {
        out.push(hook);
        continue;
      }
      const prefix = hook.path.slice(0, cut + 1);
      const last = out.at(-1);
      const values = (one: Shown) => slotState(fiber, one.slot);
      // Still inside the same call of that library hook: added to its line.
      if (last?.group !== undefined && last.count !== undefined && last.group.join(" ") === prefix.join(" ") && last.index + last.count === hook.index) {
        last.count += 1;
        if (hook.state) last.value = brief(values(hook));
        const key = values(hook)?.options?.queryKey;
        if (Array.isArray(key)) last.deps = preview(key, 1);
        continue;
      }
      const key = values(hook)?.options?.queryKey;
      out.push({ ...hook, kind: prefix.at(-1) as string, path: prefix.slice(0, -1), group: prefix, count: 1, value: hook.state ? brief(values(hook)) : undefined, deps: Array.isArray(key) ? preview(key, 1) : undefined });
    }
    return out;
  };

  // A boundary as a reply names it: what it is, and the app's component around it.
  const described = (fiber: Fiber) => {
    const around = (() => {
      for (let at = fiber.return; at; at = at.return) if (COMPOSITE.has(at.tag) && !fromLibrary(at)) return nameOf(at);
      return null;
    })();
    const from = fromLibrary(fiber) ? packageOfFiber(fiber) : null;
    return `${label(fiber)}${from ? ` (from ${from})` : ""}${around ? ` in ${around}` : ""}`;
  };
  const summary = (fiber: Fiber) => ({
    id: `c${idOf(fiber)}`,
    name: nameOf(fiber),
    key: fiber.key,
    props: fiber.memoizedProps,
    // A function component's state hooks, by the numbers inspect gives them.
    state: fiber.tag === CLASS ? fiber.memoizedState : Object.fromEntries(hooksOf(fiber).filter((hook) => hook.state).map((hook) => [hook.index, slotState(fiber, hook.slot)])),
  });
  const slotState = (fiber: Fiber, index: number) => {
    let hook = fiber.memoizedState;
    for (let i = 0; i < index && hook; i++) hook = hook.next;
    return hook?.memoizedState;
  };

  Object.defineProperty(page, "weblab", { value: Object.assign(page.weblab ?? {}, { react }), configurable: true, writable: true, enumerable: false });
};

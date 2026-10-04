// Waiting and checking. `expect` is one check, retried until it holds
// or the step's time runs out, which makes it the way to wait for
// something too; its forms are the table below.
import { briefError } from "../errors.ts";
import type { Page } from "playwright-core";
import { UsageError } from "../errors.ts";
import type { Action, ActionContext } from "../types.ts";
import { globRegExp } from "../util.ts";
import { arg, bad, isObject, step } from "./args.ts";
import { hasTarget, locate } from "./target.ts";

/**
 * How a `url`, `title`, `console` message or `request` is matched in `expect`:
 * a plain string must be contained, a string with `*` is a glob over
 * the whole value, and `{ regex, flags }` is a regular expression.
 */
function matcher(wanted: unknown, action: string): (actual: string) => boolean {
  if (isObject(wanted) && typeof wanted.regex === "string") {
    let expression: RegExp;
    try {
      expression = new RegExp(wanted.regex, wanted.flags as string | undefined);
    } catch (error) {
      throw new UsageError(`${action}: ${(error as Error).message}`);
    }
    return (actual) => expression.test(actual);
  }
  if (typeof wanted !== "string") return bad(action, `a string, a glob with *, or { regex, flags }`);
  if (!wanted.includes("*")) return (actual) => actual.includes(wanted);
  const glob = globRegExp(wanted);
  return (actual) => glob.test(actual);
}

// A target as the step author would write it: a selector or ref as it
// is, anything richer as JSON.
const show = (target: unknown): string => {
  if (typeof target === "string") return target;
  const only = isObject(target) && Object.keys(target).length === 1 ? (target.target ?? target.selector) : undefined;
  return only === undefined ? JSON.stringify(target) : show(only);
};
const short = (text: string, max = 160) => (text.length <= max ? text : `${text.slice(0, max)}...`);

// Responses whose URL shares the most words with a pattern that matched none.
function nearMisses(seen: string[], pattern: unknown): string[] {
  const words = (typeof pattern === "string" ? pattern : JSON.stringify(pattern)).split(/[^\w-]+/).filter((word) => word.length >= 3);
  const score = (line: string) => words.filter((word) => line.includes(word)).length;
  return [...new Set(seen)]
    .map((line) => [line, score(line)] as const)
    .filter(([, points]) => points > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([line]) => short(line));
}

// A short wait of its own: the poll around each read does the retrying.
const QUICK = { timeout: 250 };

// Text on the page means text in any of its frames, as `look` shows it.
async function visibleText(page: Page, text: string, exact?: boolean): Promise<number> {
  const counts = await Promise.all(
    page.frames().map((frame) => frame.getByText(text, { exact }).filter({ visible: true }).count().catch(() => 0)),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * One form of `expect`. `holds` is retried until it is true or the
 * timeout runs out; `once` marks a check nothing in the page can
 * change, so it is tried a single time.
 */
type ExpectationBuilder = (ctx: ActionContext, args: any) => {
  holds(): Promise<boolean>;
  wanted(): string;
  once?: boolean;
};

// Arguments come straight from JSON, so each action checks its own.

// One entry per form of `expect`: the key that selects it, how to check
// it and say what was wanted, and (for the error message) its shape.
type Expectation = [key: string, build: ExpectationBuilder, shape?: string];

const visibleCheck: ExpectationBuilder = (ctx, { visible }) => ({
  holds: () => locate(ctx, visible, "expect").isVisible(),
  wanted: () => `${show(visible)} to be visible`,
});

const EXPECTATIONS: Expectation[] = [
  ["visible", visibleCheck],
  [
    "hidden",
    (ctx, { hidden }) => ({
      holds: async () => (await locate(ctx, hidden, "expect", { all: true }).filter({ visible: true }).count()) === 0,
      wanted: () => `${show(hidden)} to be hidden`,
    }),
  ],
  [
    "count",
    (ctx, { count, ...target }) => {
      let found = -1;
      return {
        holds: async () => (found = await locate(ctx, target, "expect", { all: true }).count()) === count,
        wanted: () => `${count} of ${show(target)}, found ${found}`,
      };
    },
    "target + count",
  ],
  [
    "value",
    (ctx, { value, ...target }) => {
      let found = "";
      return {
        holds: async () => {
          const field = locate(ctx, target, "expect");
          found = await field.inputValue(QUICK);
          if (found === String(value)) return true;
          // A dropdown matches by the label shown, too, as `select` does.
          const labels = await field.evaluate(
            (element) => (element instanceof HTMLSelectElement ? [...element.selectedOptions].map((option) => option.label) : []),
            undefined,
            QUICK,
          );
          return labels.includes(String(value));
        },
        wanted: () => `${show(target)} to have the value "${value}", found "${found}"`,
      };
    },
    "target + value",
  ],
  [
    "checked",
    (ctx, { checked, ...target }) => ({
      holds: async () => (await locate(ctx, target, "expect").isChecked(QUICK)) === checked,
      wanted: () => `${show(target)} to be ${checked ? "checked" : "unchecked"}`,
    }),
    "target + checked",
  ],
  [
    "enabled",
    (ctx, { enabled, ...target }) => ({
      holds: async () => (await locate(ctx, target, "expect").isEnabled(QUICK)) === enabled,
      wanted: () => `${show(target)} to be ${enabled ? "enabled" : "disabled"}`,
    }),
    "target + enabled",
  ],
  [
    "noText",
    ({ page }, { noText }) => ({
      holds: async () => (await visibleText(page, noText)) === 0,
      wanted: () => `no visible text "${noText}", but it's there`,
    }),
  ],
  [
    "url",
    ({ page }, { url }) => {
      const matches = matcher(url, "expect");
      return {
        holds: async () => matches(page.url()),
        wanted: () => `the URL to match ${show(url)}, it is ${page.url()}`,
      };
    },
  ],
  [
    "title",
    ({ page }, { title }) => {
      const matches = matcher(title, "expect");
      let found = "";
      return {
        holds: async () => matches((found = await page.title())),
        wanted: () => `the title to match ${show(title)}, it is "${found}"`,
      };
    },
  ],
  [
    "inViewport",
    (ctx, { inViewport }) => ({
      // Any part of it on screen, as an IntersectionObserver sees it.
      holds: () =>
        locate(ctx, inViewport, "expect").evaluate(
          (element) =>
            new Promise<boolean>((done) => {
              const observer = new IntersectionObserver(([entry]) => {
                observer.disconnect();
                done((entry?.intersectionRatio ?? 0) > 0);
              });
              observer.observe(element);
            }),
          undefined,
          QUICK,
        ),
      wanted: () => `${show(inViewport)} to be on screen`,
    }),
  ],
  [
    "js",
    ({ page }, { js }) => {
      let found: unknown;
      // An expression that throws isn't true yet, and may be once the page has caught up; what it threw is said if it never is.
      let threw: string | undefined;
      return {
        holds: async () => {
          try {
            found = await page.evaluate(js);
            threw = undefined;
          } catch (error) {
            threw = briefError(error).replace(/^page\.evaluate: /, "");
            return false;
          }
          return Boolean(found);
        },
        wanted: () => (threw === undefined ? `${short(js)} to be truthy, it was ${short(JSON.stringify(found) ?? String(found))}` : `${short(js)} to be truthy, but it threw: ${threw}`),
      };
    },
  ],
  [
    "console",
    (ctx, { console: wanted }) => {
      const matches = matcher(wanted, "expect");
      return {
        holds: async () => ctx.sinceLoad().logs.some((entry) => matches(entry.text)),
        wanted: () => `the page to have logged ${show(wanted)} since it loaded`,
      };
    },
  ],
  [
    "request",
    (ctx, { request, status }) => {
      const matches = matcher(request, "expect");
      return {
        holds: async () => ctx.sinceLoad().responses.some((response) => matches(response.url) && (status === undefined || response.status === status)),
        wanted: () => {
          const want = `a response from ${show(request)}${status === undefined ? "" : ` with status ${status}`} since the page loaded`;
          // The ones that came closest, so a glob that is nearly right shows.
          const near = nearMisses(ctx.sinceLoad().responses.map((response) => `${response.status} ${response.url}`), request);
          return near.length === 0 ? want : `${want}; responses like it:\n${near.map((line) => `    ${line}`).join("\n")}`;
        },
      };
    },
    "request (+ status)",
  ],
  [
    "noErrors",
    (ctx) => {
      // What the page logged as an error since it loaded, past what's ignored:
      // console errors and uncaught exceptions.
      const errors = () => ctx.sinceLoad().logs.filter((entry) => entry.type === "error" || entry.type === "pageerror");
      return {
        holds: async () => errors().length === 0,
        wanted: () => {
          const found = errors();
          const lines = found.slice(0, 5).map((entry) => `    ${short(entry.text)}${entry.url ? ` (${entry.url})` : ""}`);
          const more = found.length > 5 ? [`    and ${found.length - 5} more, in the console log`] : [];
          return `no console errors or page errors since the page loaded, found ${found.length}:\n${[...lines, ...more].join("\n")}`;
        },
        once: true,
      };
    },
  ],
];

// `text` beside another way of naming an element is what that element
// should contain; alone (or with only `exact`) it is text on the page.
const textForm: ExpectationBuilder = (ctx, { text, exact, ...rest }) => {
  if (!hasTarget(rest)) {
    return {
      holds: async () => (await visibleText(ctx.page, text, exact)) > 0,
      wanted: () => `the text "${text}" to be visible`,
    };
  }
  const target = exact === undefined ? rest : { ...rest, exact };
  let found = "";
  return {
    holds: async () => {
      found = (await locate(ctx, target, "expect").textContent(QUICK)) ?? "";
      return found.includes(text);
    },
    wanted: () => `${show(rest)} to contain "${text}", found "${found.trim().slice(0, 80)}"`,
  };
};

// A check that throws (the page is mid-navigation, `window.app` is not
// there yet) has not held yet, which is the same as false. A malformed
// check is the author's mistake and no amount of waiting fixes it.
async function poll(check: () => Promise<boolean>, timeout: number): Promise<boolean> {
  const attempt = () =>
    check().catch((error) => {
      if (error instanceof UsageError) throw error;
      return false;
    });
  for (const deadline = Date.now() + timeout; ; ) {
    if (await attempt()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Every key an `expect` may hold, beside a target. */
export const EXPECT_KEYS = [...EXPECTATIONS.map(([key]) => key), "text", "status", "timeout", "message"];

export const checkSteps: Record<string, Action> = {
  wait: step(async (ctx, args) => {
    const { ms } = arg<{ ms: number }>(args, "ms", "wait");
    if (!Number.isFinite(Number(ms))) bad("wait", "a number of milliseconds");
    await ctx.page.waitForTimeout(Number(ms));
  }),

  expect: step(async (ctx, given) => {
    // A plain string is text that should be visible.
    const args = typeof given === "string" ? { text: given } : given;
    if (!isObject(args)) bad("expect", `text that should be visible, or { visible | hidden | text | url | js | ... }`);
    // Options are not part of what names the element.
    const { timeout, message, ...check } = args as { timeout?: number; message?: string } & Record<string, unknown>;
    // `text` wherever it sits beside a target first (so a target named
    // by `title` is not taken for the page title), then the forms in order.
    // A target and nothing else is an element that should be visible.
    const visible: ExpectationBuilder = (on, target) => visibleCheck(on, { visible: target });
    const build =
      (check.text !== undefined && hasTarget(check, ["text"]) ? textForm : undefined) ??
      EXPECTATIONS.find(([key]) => check[key] !== undefined)?.[1] ??
      (check.text !== undefined ? textForm : undefined) ??
      (hasTarget(check) ? visible : undefined);
    if (build === undefined) {
      const forms = [...EXPECTATIONS.map(([key, , shape]) => shape ?? key), "text | target + text", "target"];
      return bad("expect", `text that should be visible, or { ${forms.join(" | ")} }`);
    }
    const { holds, wanted, once } = build(ctx, check);
    const ok = once ? await holds() : await poll(holds, timeout ?? ctx.timeout);
    if (!ok) ctx.fail(message ?? `expected ${wanted()}`);
  }),
};

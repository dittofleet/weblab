// How a step says which element it means. Every step that takes an
// element takes any of these forms, so a script can use whichever
// reads best or survives the app's changes longest:
//
//   "button.save"                         a Playwright selector
//   "e12"                                 a ref printed by the `look` step
//   { "role": "button", "name": "Save" }  an accessible role and name
//   { "label": "Email" }                  a form field by its label
//   { "placeholder": "Search" }, { "text": "Sign in" }, { "testId": "cart" },
//   { "altText": "Logo" }, { "title": "Close" }
//
// plus, on any object form but a ref: `nth` (which match, from 0),
// `frame` (an iframe to look inside), `within` (another target to look
// inside), and `exact` (match text exactly rather than as a substring).
//
// A target usually sits flat in the step's own object, beside the
// step's options, and can always be given whole under `target` instead.
// Only `expect` reads a few of these keys for itself (`text`, `title`).

import type { FrameLocator, Locator, Page } from "playwright-core";
import { UsageError } from "../errors.ts";
import type { ActionContext } from "../types.ts";
import { bad, isObject, pick } from "./args.ts";

/** Every way to name an element in object form. */
export const WAYS = ["ref", "selector", "role", "label", "placeholder", "text", "testId", "altText", "title"] as const;
type Way = (typeof WAYS)[number];

type TargetSpec = Partial<Record<Way, string>> & {
  name?: string;
  // How Playwright narrows a role further.
  level?: number;
  checked?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  exact?: boolean;
  nth?: number;
  frame?: string;
  within?: Target;
};
type Target = string | TargetSpec;

/** Every key an object target may hold. */
export const TARGET_KEYS = [...WAYS, "name", "nth", "exact", "frame", "within", "target", "level", "checked", "pressed", "expanded", "selected", "disabled"];


const REF = /^(f\d+)?e\d+$/;
const SHAPE = `a selector, a ref, or { ${WAYS.join(" | ")} }`;

/** True when the step's arguments name an element, leaving out keys the step reads for itself. */
export const hasTarget = (args: unknown, skip: Way[] = []): boolean =>
  typeof args === "string" ||
  (isObject(args) &&
    (args.target !== undefined || WAYS.some((way) => !skip.includes(way) && args[way] !== undefined)));

/**
 * The page, or one element, as an accessibility tree. Playwright gives
 * the elements of a tree with refs fresh numbers each time, and clears
 * them when it takes a tree without; where the steps keep track of refs
 * (a session), this keeps what a ref may name in step with that.
 */
export async function ariaTree(
  ctx: ActionContext,
  root: Locator,
  { refs, depth, timeout }: { refs: boolean; depth?: number; timeout?: number },
): Promise<string> {
  const tree = await root.ariaSnapshot({ ...(refs ? { mode: "ai" as const } : {}), depth, timeout });
  if (ctx.refs !== undefined) {
    ctx.refs = refs
      ? { page: ctx.page, url: ctx.page.url(), load: ctx.loads(), names: new Set([...tree.matchAll(/\[ref=(\w+)\]/g)].map((match) => match[1] as string)) }
      : null;
  }
  return tree;
}

// A ref names one element of the latest tree, in whichever frame it
// was. One that tree didn't print, or one from a page the steps have
// since left, can't turn up by waiting, so it is reported at once.
function byRef(ctx: ActionContext, ref: string): Locator {
  const refs = ctx.refs;
  if (refs !== undefined) {
    // A ref from any document but a tab's first (a frame, or the page
    // after it loads again) carries that document's number: f2e12.
    const meant = refs?.names.has(ref) === false ? [...refs.names].find((name) => name.endsWith(ref) && REF.test(name)) : undefined;
    const problem =
      refs === null
        ? "no refs are current (the latest look printed none)"
        : refs.page !== ctx.page || refs.url !== ctx.page.url()
          ? `${ref} is from a look at ${refs.url}, and the page has changed since`
          : refs.load !== ctx.loads()
            ? `${ref} is from a look before the page loaded again`
            : refs.names.has(ref)
              ? null
              : `the latest look didn't print ${ref}${meant === undefined ? "" : ` (did you mean ${meant}?)`}`;
    if (problem !== null) throw new UsageError(`${problem}: run a look step, and use a ref it prints`);
  }
  return ctx.page.locator(`aria-ref=${ref}`);
}

export function locate(
  ctx: ActionContext,
  target: unknown,
  action: string,
  // `all` keeps every match, for counting.
  { all = false } = {},
): Locator {
  // Given whole under `target`, nothing in it belongs to the step.
  if (isObject(target) && target.target !== undefined) return locate(ctx, target.target, action, { all });

  const one = (found: Locator, nth?: number) =>
    nth !== undefined ? found.nth(nth) : all ? found : found.first();

  if (typeof target === "string") {
    if (REF.test(target)) return byRef(ctx, target);
    return one(ctx.page.locator(target));
  }
  if (!isObject(target)) return bad(action, SHAPE);
  const spec = target as TargetSpec;
  if (spec.ref !== undefined) return byRef(ctx, spec.ref);

  let scope: Page | Locator | FrameLocator = ctx.page;
  if (spec.within !== undefined) scope = locate(ctx, spec.within, action);
  if (spec.frame !== undefined) scope = scope.frameLocator(spec.frame);

  const { exact } = spec;
  const way = WAYS.find((key) => spec[key] !== undefined);
  const value = way === undefined ? "" : (spec[way] as string);
  switch (way) {
    case "selector":
      return one(scope.locator(value), spec.nth);
    case "role":
      return one(
        scope.getByRole(value as Parameters<Page["getByRole"]>[0], {
          name: spec.name,
          exact,
          ...pick(spec, ["level", "checked", "pressed", "expanded", "selected", "disabled"]),
        }),
        spec.nth,
      );
    case "label":
      return one(scope.getByLabel(value, { exact }), spec.nth);
    case "placeholder":
      return one(scope.getByPlaceholder(value, { exact }), spec.nth);
    case "text":
      return one(scope.getByText(value, { exact }), spec.nth);
    case "testId":
      return one(scope.getByTestId(value), spec.nth);
    case "altText":
      return one(scope.getByAltText(value, { exact }), spec.nth);
    case "title":
      return one(scope.getByTitle(value, { exact }), spec.nth);
    default:
      return bad(action, SHAPE);
  }
}

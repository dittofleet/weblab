// Pointer and keyboard. Anything that takes an element also takes a
// point (`{ "x": 120, "y": 340 }`), for canvases and maps where there's
// no element to name.
import type { Locator } from "playwright-core";
import type { Action, ActionContext } from "../types.ts";
import { arg, bad, isObject, pick, step } from "./args.ts";
import { hasTarget, locate } from "./target.ts";

type Point = { x: number; y: number };
const isPoint = (value: unknown): value is Point => isObject(value) && typeof value.x === "number" && typeof value.y === "number";

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// Where an element's middle is, scrolled into view first.
async function middleOf(ctx: ActionContext, target: Locator): Promise<Point> {
  await target.waitFor({ state: "visible" });
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) ctx.fail("the element has no box on the page");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// A headless capture has no pointer of its own, so in a recording the
// drawn cursor glides to where something happens before it happens.
async function glide(ctx: ActionContext, to: Point): Promise<void> {
  if (!ctx.video) return;
  const from = ctx.mouse;
  const frames = 28;
  for (let frame = 1; frame <= frames; frame += 1) {
    const t = easeInOut(frame / frames);
    await ctx.page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await ctx.page.waitForTimeout(12);
  }
  ctx.mouse = to;
  await ctx.page.waitForTimeout(300);
}

// In a recording, a beat after each action so the result can be seen.
const settle = (ctx: ActionContext) => (ctx.video ? ctx.page.waitForTimeout(500) : Promise.resolve());

// Passed through to Playwright as given.
const pointerOptions = (args: unknown, keys = ["button", "modifiers", "position", "force"]) => (isObject(args) ? pick(args, keys) : {});

// The OS only opens what it draws itself (a <select>'s menu, a context
// menu) for the window in front. A browser with a window is brought
// forward before the click or key that may open one; if it is in front
// already, nothing changes.
const front = (ctx: ActionContext) => (ctx.windowed ? ctx.page.bringToFront().catch(() => {}) : undefined);

export const inputSteps: Record<string, Action> = {
  click: step("click an element or a point: target or { x, y }, plus button, count, modifiers", async (ctx, args) => {
    const clickCount = isObject(args) ? (args.count as number | undefined) : undefined;
    await front(ctx);
    if (isPoint(args) && !hasTarget(args)) {
      await glide(ctx, args);
      await ctx.page.mouse.click(args.x, args.y, { ...pointerOptions(args, ["button"]), clickCount });
    } else {
      const target = locate(ctx, args, "click");
      if (ctx.video) await glide(ctx, await middleOf(ctx, target));
      await target.click({ ...pointerOptions(args), clickCount });
    }
    await settle(ctx);
  }),

  hover: step("move the pointer over an element or a point: target or { x, y }", async (ctx, args) => {
    if (isPoint(args) && !hasTarget(args)) {
      await glide(ctx, args);
      await ctx.page.mouse.move(args.x, args.y);
      ctx.mouse = args;
      return;
    }
    const target = locate(ctx, args, "hover");
    if (ctx.video) await glide(ctx, await middleOf(ctx, target));
    // Hover takes no button.
    await target.hover(pointerOptions(args, ["modifiers", "position", "force"]));
  }),

  drag: step("drag from one element or point to another: { from, to }", async (ctx, args) => {
    if (!isObject(args) || args.from === undefined || args.to === undefined) bad("drag", "{ from, to }, each a target or { x, y }");
    const at = async (end: unknown): Promise<Point> => (isPoint(end) && !hasTarget(end) ? end : middleOf(ctx, locate(ctx, end, "drag")));
    const from = await at(args.from);
    const to = await at(args.to);
    // Moved in steps, so apps that track the pointer (sortable lists,
    // canvases) see a drag rather than a jump.
    await glide(ctx, from);
    await ctx.page.mouse.move(from.x, from.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(to.x, to.y, { steps: 20 });
    await ctx.page.mouse.up();
    ctx.mouse = to;
    await settle(ctx);
  }),

  scroll: step(`scroll an element into view, or scroll the page or an element: target, { by: { x, y } } or { to: "top" | "bottom" }, with or without a target`, async (ctx, args) => {
    const by = isObject(args) && isObject(args.by) ? (args.by as Partial<Point>) : undefined;
    const to = isObject(args) ? args.to : undefined;
    if (to !== undefined && to !== "top" && to !== "bottom") bad("scroll", `to "top" or "bottom"`);
    const movement = { x: by?.x ?? 0, y: by?.y ?? 0, top: to === "top", bottom: to === "bottom" };
    if (by === undefined && to === undefined) {
      if (!hasTarget(args)) bad("scroll", `a target to bring into view, { by: { x, y } }, or { to: "top" | "bottom" }`);
      await locate(ctx, args, "scroll").scrollIntoViewIfNeeded();
    } else if (hasTarget(args)) {
      // Inside a scrolling element: a sidebar, a list, a code block.
      await locate(ctx, args, "scroll").evaluate((element, move) => {
        if (move.top || move.bottom) element.scrollTop = move.top ? 0 : element.scrollHeight;
        else element.scrollBy(move.x, move.y);
      }, movement);
    } else {
      await ctx.page.evaluate((move) => {
        if (move.top || move.bottom) scrollTo(0, move.top ? 0 : document.documentElement.scrollHeight);
        else scrollBy(move.x, move.y);
      }, movement);
    }
  }),

  press: step(`press a key or chord, on the page or an element: "Enter", "Meta+k", or { key, ...target }`, async (ctx, args) => {
    // A bare string is the key, so an element is only named in the object form.
    const { key } = arg<{ key: string }>(args, "key", "press");
    if (key === undefined) bad("press", `a key like "Enter", or { key, ...target }`);
    await front(ctx);
    if (isObject(args) && hasTarget(args)) await locate(ctx, args, "press").press(String(key));
    else await ctx.page.keyboard.press(String(key));
  }),

  type: step(`type key by key into what has focus, or into an element: "text" or { value, delay, ...target }`, async (ctx, args) => {
    const { value, delay } = arg<{ value?: string; delay?: number }>(args, "value", "type");
    if (value === undefined) bad("type", `the text to type, or { value, delay, ...target }`);
    if (isObject(args) && hasTarget(args)) await locate(ctx, args, "type").focus();
    await ctx.page.keyboard.type(String(value), { delay: delay ?? (ctx.video ? 45 : 0) });
  }),
};

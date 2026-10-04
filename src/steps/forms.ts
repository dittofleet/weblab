// Forms.
import type { Action } from "../types.ts";
import { bad, isObject, step } from "./args.ts";
import { locate } from "./target.ts";

export const formSteps: Record<string, Action> = {
  fill: step(async (ctx, args) => {
    if (!isObject(args) || args.value === undefined) bad("fill", "{ value, ...target }");
    await locate(ctx, args, "fill").fill(String(args.value));
  }),

  select: step(async (ctx, args) => {
    if (!isObject(args) || args.option === undefined) {
      bad("select", `{ option, ...target }, where option is a value or label, a list of them, or { index }`);
    }
    await locate(ctx, args, "select").selectOption(args.option as string | string[] | { index: number });
  }),

  check: step(async (ctx, args) => {
    const checked = isObject(args) && args.checked === false ? false : true;
    await locate(ctx, args, "check").setChecked(checked);
  }),

  upload: step(async (ctx, args) => {
    const files: unknown = args?.files ?? (args?.file === undefined ? undefined : [args.file]);
    if (!isObject(args) || !Array.isArray(files)) bad("upload", "{ file, ...target } or { files: [...], ...target }");
    const paths = await Promise.all((files as string[]).map((file) => ctx.resolveFile(file)));
    const target = locate(ctx, args, "upload");
    // setInputFiles works on hidden inputs, so no file picker opens.
    const isInput = await target.evaluate((element) => element instanceof HTMLInputElement && element.type === "file");
    if (isInput) return void (await target.setInputFiles(paths));
    // Anything else (a drop zone, a button) is clicked, and the picker it opens is answered.
    const [chooser] = await Promise.all([ctx.page.waitForEvent("filechooser"), target.click()]);
    await chooser.setFiles(paths);
  }),
};

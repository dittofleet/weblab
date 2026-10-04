// Places in code put back as places in the source, through source maps:
// what weblab does to the stacks in console output, for the page's code
// and for an Electron app's main process, whose code is files on disk.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { mapText, sourceMapper } from "../src/sources.ts";

const dir = mkdtempSync(join(tmpdir(), "weblab-sources-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a stack's frames point at the source, whether the code came from a server or from disk", async () => {
  writeFileSync(join(dir, "main.ts"), `type Shape = { side: number };\n\nexport function area(shape: Shape): number {\n  throw new Error("no area for " + shape.side);\n}\n`);
  const built = await Bun.build({ entrypoints: [join(dir, "main.ts")], outdir: join(dir, "build"), sourcemap: "linked" });
  assert.ok(built.success);
  const code = readFileSync(join(dir, "build", "main.js"), "utf8");
  const lines = code.split("\n");
  const line = lines.findIndex((text) => text.includes("throw new Error")) + 1;
  const column = (lines[line - 1] as string).indexOf("throw") + 1;
  const mapper = sourceMapper(async () => null, dir);
  const file = join(dir, "build", "main.js");

  // A path on disk, as Node prints it, and the same file as a file:// address.
  const fromDisk = await mapText(`Error: no area for 2\n    at area (${file}:${line}:${column})`, (place) => mapper.known(place));
  assert.equal(fromDisk, "Error: no area for 2\n    at area (main.ts:4:3)");
  const fromUrl = await mapText(`at area (${pathToFileURL(file).href}:${line}:${column})`, (place) => mapper.known(place));
  assert.equal(fromUrl, "at area (main.ts:4:3)");
  // Code a map says came from no source isn't put down to what precedes it. A map inline in the script may hold commas.
  const inline = (mappings: string) =>
    `//# sourceMappingURL=data:application/json,${JSON.stringify({ version: 3, sources: ["a.ts", "b.ts"], names: [], mappings })}`;
  writeFileSync(join(dir, "gap.js"), `let a = 1; let b = 2;\n${inline("AAAA,U")}`);
  const gap = join(dir, "gap.js");
  assert.equal(await mapText(`at x (${gap}:1:1)`, (place) => mapper.known(place)), "at x (a.ts:1:1)");
  assert.equal(await mapText(`at x (${gap}:1:12)`, (place) => mapper.known(place)), `at x (${gap}:1:12)`);
  // A place no map knows is left as it was.
  assert.equal(await mapText("at x (/nowhere/at/all.js:1:2)", (place) => mapper.known(place)), "at x (/nowhere/at/all.js:1:2)");
});

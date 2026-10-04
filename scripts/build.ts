// Compiles weblab into one self-contained binary per target.
//   bun scripts/build.ts                          this machine, to dist/weblab
//   bun scripts/build.ts darwin-arm64 darwin-x64  named targets, to dist/weblab-<target>
import { $ } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// playwright-core reads two of its own JSON files from disk at startup,
// by a path built from __dirname. In a compiled binary that path is the
// build machine's, so the binary would only run where it was built.
// Requiring them by a literal path lets the bundler carry them instead.
const FROM_DISK = /require\(import_path\d*\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g;
const embedPlaywrightData: Bun.BunPlugin = {
  name: "embed-playwright-data",
  setup(build) {
    build.onLoad({ filter: /playwright-core\/lib\/[^/]+\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      return { contents: source.replace(FROM_DISK, 'require("../$1.json")'), loader: "js" };
    });
  },
};

// A release is built from its tag, vX.Y.Z, which becomes its version: no
// file in the repository holds one. Built from anything else, it is "dev".
const tag = process.env.GITHUB_REF_NAME ?? "";
const version = /^v\d+\.\d+\.\d+$/.test(tag) ? tag.slice(1) : "dev";

async function build(outfile: string, target?: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, "src/main.ts")],
    define: { WEBLAB_VERSION: JSON.stringify(version) },
    plugins: [embedPlaywrightData],
    // Reached only on paths weblab never takes (Firefox over BiDi,
    // Electron), and not installed.
    external: ["chromium-bidi/*", "electron"],
    compile: { outfile, ...(target === undefined ? {} : { target: `bun-${target}` as Bun.Build.CompileTarget }) },
  });
  if (!result.success) throw new AggregateError(result.logs, `build failed: ${outfile}`);
  // An arm64 Mac kills a binary whose signature does not hold, and the
  // one bun leaves does not always. Ad-hoc is enough to run locally.
  await $`codesign --force --sign - ${outfile}`.quiet();
  console.log(`built ${outfile} (${version})`);
}

const targets = process.argv.slice(2);
if (targets.length === 0) await build(join(root, "dist/weblab"));
for (const target of targets) await build(join(root, `dist/weblab-${target}`), target);

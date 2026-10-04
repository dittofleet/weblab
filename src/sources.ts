// Where in the project's source a place in the page's code is. The page
// runs what its dev server made of the source (TypeScript stripped, JSX
// turned into calls, imports rewritten), and stacks point into that.
// The source map each script carries says where that came from.
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A place in code: 1-based line and column, as stacks print them. */
export type Place = { file: string; line: number; column?: number };

/** Where an element was made, as the page hands it back: React 19's stack, or React 18's file and line. */
export type Made = string | { fileName: string; lineNumber: number; columnNumber?: number } | null;

// ---- stacks

// V8:            "    at CartPage (http://localhost:5173/src/CartPage.tsx:31:9)"
// WebKit, Gecko: "CartPage@http://localhost:5173/src/CartPage.tsx:31:9"
const V8_FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;
const OTHER_FRAME = /^(.*?)@(.+?):(\d+):(\d+)$/;

/** The frames of a stack, top first. */
export function framesOf(stack: string): Place[] {
  const frames: Place[] = [];
  for (const line of stack.split("\n")) {
    const match = V8_FRAME.exec(line) ?? OTHER_FRAME.exec(line.trim());
    if (match) frames.push({ file: match[2] as string, line: Number(match[3]), column: Number(match[4]) });
  }
  return frames;
}

// React's own code, which a stack passes through on the way to the app's.
// The page script (src/react/page.ts) takes it as source, as it can't import.
export const REACT_ITSELF = /(^|[/\\])(react|react-dom|scheduler)[/\\](cjs|umd)[/\\]|react[-_]jsx[-_](dev[-_])?runtime|react-dom[-_.]|[/\\]react(\.development)?\.js|[/\\]react_/;

// ---- source maps

type Segment = [column: number, source: number, line: number, sourceColumn: number];
type Mapping = { sources: string[]; lines: Segment[][] } | { sections: { line: number; column: number; map: Mapping }[] };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// Each base64 character's value, by its character code: maps run to megabytes.
const DIGIT = new Int8Array(128);
for (let i = 0; i < BASE64.length; i++) DIGIT[BASE64.charCodeAt(i)] = i;

// A map's mappings, decoded: per generated line, its segments in order of column.
function decode(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let source = 0;
  let line = 0;
  let sourceColumn = 0;
  for (const text of mappings.split(";")) {
    const segments: Segment[] = [];
    let column = 0;
    for (const part of text.split(",")) {
      if (part === "") continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (let i = 0; i < part.length; i++) {
        const digit = DIGIT[part.charCodeAt(i) & 127] as number;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      column += fields[0] ?? 0;
      // A segment of one field starts code that came from no source: kept, so what precedes it doesn't claim it.
      if (fields.length < 4) {
        segments.push([column, -1, 0, 0]);
        continue;
      }
      source += fields[1] as number;
      line += fields[2] as number;
      sourceColumn += fields[3] as number;
      segments.push([column, source, line, sourceColumn]);
    }
    lines.push(segments);
  }
  return lines;
}

function parseMap(raw: any, url: string): Mapping {
  if (Array.isArray(raw.sections)) {
    return { sections: raw.sections.map((section: any) => ({ line: section.offset?.line ?? 0, column: section.offset?.column ?? 0, map: parseMap(section.map, url) })) };
  }
  const root = typeof raw.sourceRoot === "string" && raw.sourceRoot !== "" ? raw.sourceRoot.replace(/\/?$/, "/") : "";
  const sources = (raw.sources as (string | null)[]).map((source) => resolveSource(`${root}${source ?? ""}`, url));
  return { sources, lines: decode(raw.mappings ?? "") };
}

// A source as the map names it, against where the map is. A rooted
// path stays as it is: a file on disk, or a path on the server.
function resolveSource(source: string, url: string): string {
  if (source.startsWith("/") || /^[a-z][\w+.-]*:/i.test(source)) return source;
  try {
    return new URL(source, url).href;
  } catch {
    return source;
  }
}

function lookup(map: Mapping, line: number, column: number): Place | null {
  if ("sections" in map) {
    const section = map.sections.findLast((one) => one.line < line || (one.line === line && one.column <= column));
    if (section === undefined) return null;
    return lookup(section.map, line - section.line, line === section.line ? column - section.column : column);
  }
  const segments = map.lines[line];
  if (segments === undefined || segments.length === 0) return null;
  // The last segment starting at or before the column, or else the line's first.
  // A minified file is one line of many segments, so they are searched by halves.
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((segments[middle] as Segment)[0] <= column) low = middle;
    else high = middle - 1;
  }
  const found = segments[low] as Segment;
  if (found[1] === -1) return null;
  const file = map.sources[found[1]];
  return file === undefined ? null : { file, line: found[2] + 1, column: found[3] + 1 };
}

const MAP_COMMENT = /\/\/[#@] sourceMappingURL=(\S+)\s*$/;

/**
 * Turns places in the page's code into places in the project's source,
 * fetching each script and its map once. `fetchText` reads a URL as the
 * page would (same cookies), or gives null.
 */
export type SourceMapper = ReturnType<typeof sourceMapper>;

export function sourceMapper(fetchText: (url: string) => Promise<string | null>, root: string) {
  const roots = [root, ...(() => {
    try {
      const real = realpathSync(root);
      return real === root ? [] : [real];
    } catch {
      return [];
    }
  })()];
  const maps = new Map<string, Promise<Mapping | null | undefined>>();
  // A script read and found to have no map is remembered. One that couldn't be read is tried again next time.
  const mapOf = (url: string) => {
    let map = maps.get(url);
    if (map === undefined) {
      map = loadMap(url).catch(() => null);
      maps.set(url, map);
      void map.then((found) => found === undefined && maps.delete(url));
    }
    return map.then((found) => found ?? null);
  };
  async function loadMap(url: string): Promise<Mapping | null | undefined> {
    const code = await readText(url);
    if (code === null) return undefined;
    const comment = code === null ? null : MAP_COMMENT.exec(code.trimEnd().split("\n").at(-1) ?? "");
    if (comment === null || comment === undefined) return null;
    const where = comment[1] as string;
    if (where.startsWith("data:")) {
      // The map's own text may hold commas, unencoded: only the first ends the header.
      const comma = where.indexOf(",");
      const [head, body] = [where.slice(0, comma), where.slice(comma + 1)];
      const text = head?.endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
      return parseMap(JSON.parse(text), url);
    }
    const mapUrl = new URL(where, url).href;
    const text = await readText(mapUrl);
    return text === null ? undefined : parseMap(JSON.parse(text), mapUrl);
  }
  const readText = (url: string) => (url.startsWith("file:") ? readFile(fileURLToPath(url), "utf8").catch(() => null) : fetchText(url));

  // Whether a rooted path is the server's, under the project, rather than a file on disk: asked once a path.
  const servedPaths = new Map<string, boolean>();
  const served = (path: string) => {
    let answer = servedPaths.get(path);
    if (answer === undefined) servedPaths.set(path, (answer = !existsSync(path) && existsSync(join(root, path))));
    return answer;
  };

  /** A place in the source, as the project would name it: relative to its root when it is inside. */
  function shown(place: Place): Place {
    let file = place.file.split("?")[0] as string;
    try {
      if (file.startsWith("file:")) file = fileURLToPath(file);
      else if (/^https?:/.test(file)) file = decodeURIComponent(new URL(file).pathname).replace(/^\/@fs\//, "/");
      else if (file.startsWith("webpack://")) file = file.replace(/^webpack:\/\/[^/]*\//, "").replace(/^\.\//, "");
    } catch {
      return place;
    }
    // A path the server serves from the project's root (as vite does), or a file on disk.
    if (file.startsWith("/") && served(file)) file = join(root, file);
    // Relative to the project, reached by its own path or the one its symlinks lead to (/var is /private/var).
    if (isAbsolute(file)) {
      for (const base of roots) {
        const inside = relative(base, file);
        if (!inside.startsWith("..") && !isAbsolute(inside)) {
          file = inside;
          break;
        }
      }
    }
    // A package's file by the package's own path: pnpm's store adds a long versioned prefix.
    const modules = file.lastIndexOf("node_modules/");
    if (modules !== -1) file = file.slice(modules + "node_modules/".length);
    return { ...place, file };
  }

  /** Where a place in the page's code came from, when a source map says, or else null. */
  async function known(place: Place): Promise<Place | null> {
    const map = await mapOf(place.file);
    const found = map === null ? null : lookup(map, place.line - 1, (place.column ?? 1) - 1);
    return found === null ? null : shown(found);
  }

  /** Where the app's code made an element: the first frame of its stack outside React. */
  async function where(made: Made): Promise<Place | null> {
    if (made === null) return null;
    if (typeof made !== "string") return shown({ file: made.fileName, line: made.lineNumber, column: made.columnNumber });
    for (const frame of framesOf(made)) {
      if (REACT_ITSELF.test(frame.file)) continue;
      const place = (await known(frame)) ?? shown(frame);
      if (REACT_ITSELF.test(place.file)) continue;
      return place;
    }
    return null;
  }

  return { known, where };
}

// A place in code within a line of text: the page's, "(http://localhost:5173/src/App.tsx?t=1:12:5)",
// or a file's on disk, as an Electron app's main process names them, "(/app/.vite/build/main.js:40:11)".
const PLACE_IN_TEXT = /(https?:\/\/[^\s()'"]+?|file:\/\/[^\s()'"]+?|(?<=[(\s]|^)\/[^\s()'"]+?):(\d+):(\d+)/g;

/** A line of text (a console message, a stack) with the places in code in it put as places in the project's source. */
export async function mapText(text: string, map: (place: Place) => Promise<Place | null>): Promise<string> {
  const found = [...text.matchAll(PLACE_IN_TEXT)];
  if (found.length === 0) return text;
  const address = (file: string) => (file.startsWith("/") ? pathToFileURL(file).href : file);
  const mapped = await Promise.all(found.map((match) => map({ file: address(match[1] as string), line: Number(match[2]), column: Number(match[3]) }).catch(() => null)));
  let at = 0;
  let out = "";
  found.forEach((match, i) => {
    const place = mapped[i];
    out += text.slice(at, match.index) + (place ? placeText(place) : match[0]);
    at = (match.index ?? 0) + match[0].length;
  });
  return out + text.slice(at);
}

export const placeText = (place: Place) => `${place.file}:${place.line}${place.column === undefined ? "" : `:${place.column}`}`;

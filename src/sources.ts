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
export const REACT_ITSELF = /(^|[/\\])(react|react-dom|scheduler)[/\\](cjs|umd)[/\\]|react[-_]jsx[-_](dev[-_])?runtime|react-dom[-_.]|[/\\]react(\.development)?\.js|react-server-dom/;

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

// A server component's frame, as React passes it to the page: its server
// code's own address, behind React's prefix and a query.
// "about://React/Server/file:///app/build/server/page.js?0" is file:///app/build/server/page.js.
const serverFile = (file: string) => {
  const bare = file.replace(/^(?:about|rsc):\/\/React\/Server\//, "");
  return bare === file ? file : bare.replace(/\?\d*$/, "");
};

/** The package a source file in node_modules is from: "@tanstack/react-query", "next". */
export function packageOfPath(path: string): string | null {
  const at = path.lastIndexOf("node_modules/");
  if (at === -1) return null;
  const parts = path.slice(at + "node_modules/".length).split("/");
  return (parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]) || null;
}

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
    // Code over the network may answer next time, and code that isn't (a file, evaluated code) won't.
    if (code === null) return /^https?:/.test(url) ? undefined : null;
    // The map's comment closes the script, or nearly (a sourceURL comment may follow it).
    const tail = code === null ? [] : code.trimEnd().split("\n").slice(-3).reverse();
    const comment = tail.map((line) => MAP_COMMENT.exec(line)).find((found) => found !== null) ?? null;
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
  // A file is read from disk, and anything else asked of the session: over the network, or, for code a
  // page evaluated under a name of its own, from the browser's debugger.
  const readText = (url: string) => (url.startsWith("file:") ? readFile(fileURLToPath(url), "utf8").catch(() => null) : fetchText(url));

  const found = new Map<string, string>();
  // Where a path is on disk. A file named on disk stays as it is. A path a source map named
  // may also be the project's under leading parts a bundler put before it (its name for the
  // project), so those are dropped one at a time until a file is there. A path from an address
  // the page loaded is the server's: the project's file of that path if there is one, or the path.
  const onDisk = (path: string, from: "disk" | "map" | "address"): string => {
    const asked = `${from}:${path}`;
    let answer = found.get(asked);
    if (answer === undefined) {
      const parts = path.split("/").filter((part) => part !== "" && part !== ".");
      if (isAbsolute(path) && (from === "disk" || existsSync(path))) answer = path;
      else if (from === "address") answer = existsSync(join(root, ...parts)) ? join(root, ...parts) : path;
      else {
        answer = isAbsolute(path) ? path : parts.join("/");
        for (let i = 0; i < parts.length; i++) {
          const rest = parts.slice(i).join("/");
          if (existsSync(join(root, rest))) {
            answer = join(root, rest);
            break;
          }
          if (i > 0 && existsSync(`/${rest}`)) {
            answer = `/${rest}`;
            break;
          }
        }
      }
      found.set(asked, answer);
    }
    return answer;
  };

  /** A place in the source, as the project would name it: relative to its root when it is inside. `mapped` when a source map named it. */
  function shown(place: Place, mapped = false): Place {
    // An address's path, whatever its scheme: past the scheme and the part naming the server or the bundle.
    let file = serverFile(place.file).split(/[?#]/)[0] as string;
    const address = !file.startsWith("file:") && /^[a-z][\w+.-]*:\/\//i.test(file);
    // Only a web address is a path a server serves. Any other scheme names a module, as a source map's names do.
    const served = /^https?:/i.test(file);
    try {
      if (file.startsWith("file:")) file = fileURLToPath(file);
      else if (address) file = decodeURIComponent(file.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, ""));
    } catch {
      return place;
    }
    file = onDisk(file, mapped || (address && !served) ? "map" : address ? "address" : "disk");
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

  /** True when an address's path is a file of the project's own, outside node_modules: code a map wouldn't place elsewhere. */
  function local(file: string): boolean {
    if (!/^https?:\/\//.test(file) || /[/\\]node_modules[/\\]/.test(file)) return false;
    const path = decodeURIComponent(new URL(file).pathname);
    return path !== "/" && existsSync(join(root, path)) && !/(^|\/)node_modules\//.test(path);
  }

  /** Where a place in the page's code came from, when a source map says, or else null. */
  async function known(place: Place): Promise<Place | null> {
    const found = await origin(place);
    return found === null ? null : shown(found, true);
  }

  /** Where a place came from, as its source map names the source, before it is put as the project would name it. */
  async function origin(place: Place): Promise<Place | null> {
    // A path on disk (React's own records of a file, Node's stacks) is read as a file.
    const named = serverFile(place.file);
    const file = named.startsWith("/") ? pathToFileURL(named).href : named;
    const map = await mapOf(file);
    return map === null ? null : lookup(map, place.line - 1, (place.column ?? 1) - 1);
  }

  /** Where the app's code made an element: the first frame of its stack outside React. */
  async function where(made: Made): Promise<Place | null> {
    if (made === null) return null;
    if (typeof made !== "string") return shown({ file: made.fileName, line: made.lineNumber, column: made.columnNumber });
    for (const frame of framesOf(made)) {
      if (REACT_ITSELF.test(frame.file)) continue;
      // Unmapped code with no address to read it from (evaluated by the page, or run on a server):
      // its file is right, but its line is the compiled code's.
      const unreadable = !/^(?:https?|file):/.test(serverFile(frame.file)) && /^[a-z][\w+.-]*:/i.test(frame.file);
      const place = (await known(frame)) ?? (unreadable ? { ...shown(frame), line: 0, column: undefined } : shown(frame));
      if (REACT_ITSELF.test(place.file)) continue;
      return place;
    }
    return null;
  }

  return { known, origin, where, local };
}

// A place in code within a line of text: the page's, "(http://localhost:5173/src/App.tsx?t=1:12:5)",
// or a file's on disk, as an Electron app's main process names them, "(/app/build/main.js:40:11)".
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

export const placeText = (place: Place) => (place.line === 0 ? place.file : `${place.file}:${place.line}${place.column === undefined ? "" : `:${place.column}`}`);

// Windows: the system's own calls for what is running, since nothing
// that ships with it lists processes quickly or in a fixed language.
// Offsets are for 64-bit processes, the only kind weblab is built as.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Listed, Os } from "./index.ts";

const GRACE_MS = 4000;

const { u32, i32, u64, ptr: pointer } = FFIType;

const ntdll = dlopen("ntdll.dll", {
  NtQuerySystemInformation: { args: [u32, pointer, u32, pointer], returns: u32 },
  NtQueryInformationProcess: { args: [u64, u32, pointer, u32, pointer], returns: u32 },
}).symbols;
const kernel32 = dlopen("kernel32.dll", {
  OpenProcess: { args: [u32, i32, u32], returns: u64 },
  CloseHandle: { args: [u64], returns: i32 },
  ReadProcessMemory: { args: [u64, u64, pointer, u64, pointer], returns: i32 },
}).symbols;
const iphlpapi = dlopen("iphlpapi.dll", {
  GetExtendedTcpTable: { args: [pointer, pointer, i32, u32, u32, u32], returns: u32 },
}).symbols;

const utf16 = new TextDecoder("utf-16le");
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
// 100 ns ticks from 1601, to milliseconds from 1970.
const startOf = (ticks: bigint) => new Date(Number(ticks / 10_000n) - 11_644_473_600_000).toISOString();

type Row = { pid: number; ppid: number; startedAt: string };

function rows(): Row[] {
  for (let size = 1 << 20; ; size *= 2) {
    const bytes = new Uint8Array(size);
    const status = ntdll.NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, ptr(bytes), size, null);
    if (status === STATUS_INFO_LENGTH_MISMATCH) continue;
    if (status !== 0) return [];
    const entries = view(bytes);
    const found: Row[] = [];
    for (let at = 0; ; ) {
      found.push({
        pid: Number(entries.getBigUint64(at + 80, true)),
        ppid: Number(entries.getBigUint64(at + 88, true)),
        startedAt: startOf(entries.getBigInt64(at + 32, true)),
      });
      const next = entries.getUint32(at, true);
      if (next === 0) return found;
      at += next;
    }
  }
}

const PROCESS_VM_READ = 0x10;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** Runs a query on a process, or null if it can't be opened (it has gone, or isn't this user's). */
function withProcess<T>(pid: number, access: number, query: (handle: bigint) => T | null): T | null {
  const handle = kernel32.OpenProcess(access, 0, pid) as bigint;
  if (!handle) return null;
  try {
    return query(handle);
  } finally {
    kernel32.CloseHandle(handle);
  }
}

const PROCESS_COMMAND_LINE_INFORMATION = 60;
const COMMAND_LINE_BYTES = 64 * 1024;

function commandLine(pid: number): string {
  return (
    withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (handle) => {
      const bytes = new Uint8Array(COMMAND_LINE_BYTES);
      if (ntdll.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, ptr(bytes), COMMAND_LINE_BYTES, null) !== 0) return null;
      return utf16.decode(bytes.subarray(16, 16 + view(bytes).getUint16(0, true)));
    }) ?? ""
  );
}

// A working directory is only kept in the process's own memory: its
// environment block (PEB), then its parameters, then the string.
const PEB_PARAMETERS = 0x20n;
const PARAMETERS_CURRENT_DIRECTORY = 0x38n;

function cwdOf(pid: number): string | null {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, (handle) => {
    const read = (address: bigint, length: number) => {
      const bytes = new Uint8Array(length);
      return kernel32.ReadProcessMemory(handle, address, ptr(bytes), BigInt(length), null) === 0 ? null : bytes;
    };
    const basic = new Uint8Array(48);
    if (ntdll.NtQueryInformationProcess(handle, 0, ptr(basic), 48, null) !== 0) return null;
    const parameters = read(view(basic).getBigUint64(8, true) + PEB_PARAMETERS, 8);
    if (parameters === null) return null;
    const directory = read(view(parameters).getBigUint64(0, true) + PARAMETERS_CURRENT_DIRECTORY, 16);
    if (directory === null) return null;
    const text = read(view(directory).getBigUint64(8, true), view(directory).getUint16(0, true));
    return text === null ? null : utf16.decode(text);
  });
}

// A process and all it started. A child keeps its parent's pid after the
// parent has gone, and that pid may be given out again, so a child is
// only a process's if it started after it: `since`, once it has gone.
function descendants(table: Row[], leader: number, since?: string | null): Row[] {
  const top = table.find((row) => row.pid === leader);
  const under = (parent: Pick<Row, "pid" | "startedAt">): Row[] =>
    table.filter((row) => row.ppid === parent.pid && row.startedAt >= parent.startedAt).flatMap((row) => [row, ...under(row)]);
  return [...(top === undefined ? [] : [top]), ...under({ pid: leader, startedAt: top?.startedAt ?? since ?? "" })];
}

const forceStop = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

// A console program can't be asked to close, so what is stopped is
// stopped outright. Until nothing is left: something may have been
// starting a process as its parent went.
async function stopAll(left: () => number[]): Promise<void> {
  for (let waited = 0; waited < GRACE_MS; waited += 100) {
    const pids = left();
    if (pids.length === 0) return;
    pids.forEach(forceStop);
    await sleep(100);
  }
}

// Where a few Chromium browsers install, under one of the folders installs go in.
const INSTALLED: Record<string, string> = {
  Chromium: "Chromium\\Application\\chrome.exe",
  "Brave Browser": "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  Helium: "imput\\Helium\\Application\\chrome.exe",
  Vivaldi: "Vivaldi\\Application\\vivaldi.exe",
  Opera: "Programs\\Opera\\opera.exe",
};

const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_LISTENER = 3;
// The size of each family's row, and where its port and its owner are.
const TCP_ROWS = { [AF_INET]: { size: 24, port: 8, pid: 20 }, [AF_INET6]: { size: 56, port: 20, pid: 52 } };

function listeningIn(family: typeof AF_INET | typeof AF_INET6): { port: number; pid: number }[] {
  const needed = new Uint32Array(1);
  iphlpapi.GetExtendedTcpTable(null, ptr(needed), 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
  // Room for rows that appear between asking the size and asking for the table.
  const bytes = new Uint8Array((needed[0] as number) + 4096);
  needed[0] = bytes.length;
  if (iphlpapi.GetExtendedTcpTable(ptr(bytes), ptr(needed), 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0) !== 0) return [];
  const table = view(bytes);
  const { size, port, pid } = TCP_ROWS[family];
  return Array.from({ length: table.getUint32(0, true) }, (_, row) => {
    const at = 4 + row * size;
    return { port: table.getUint16(at + port, false), pid: table.getUint32(at + pid, true) };
  });
}

export const windows: Os = {
  processTable: () =>
    rows().map((row): Listed => ({
      ...row,
      // Read when asked for: it means opening the process, and few are ever asked about.
      get command() {
        return commandLine(row.pid);
      },
    })),
  startTime: (pid) => rows().find((row) => row.pid === pid)?.startedAt ?? null,
  membersOf: (leader, since) => descendants(rows(), leader, since),
  stopGroup: (leader, since) => stopAll(() => descendants(rows(), leader, since).map((row) => row.pid)),
  stopProcess: (pid) => stopAll(() => (rows().some((row) => row.pid === pid) ? [pid] : [])),
  listeners: (port) =>
    [...listeningIn(AF_INET), ...listeningIn(AF_INET6)]
      .filter((row) => port === undefined || row.port === port)
      .map((row) => row.pid),
  cwdOf,

  // Detached, a shell and every console program under it would each
  // open a window. Not detached, the shell goes when weblab does (the
  // runtime ties its children to it), but what it ran breaks away, so
  // the group lasts: the descendants of a shell that has gone.
  ownGroup: { windowsHide: true },
  // A shell can't be the watcher, for the same two reasons, so weblab
  // itself waits on the pipe, in a detached process needing no window.
  unlessDismissed: (sweep) => sweep,

  stateHome: () => process.env.LOCALAPPDATA as string,
  executableAt: (path) => path,
  installedApp(app) {
    const path = INSTALLED[app];
    if (path === undefined) return null;
    // Not every one is set for a program an MCP client starts.
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((root) => root !== undefined);
    return roots.map((root) => join(root, path)).find((file) => existsSync(file)) ?? null;
  },
  // x64 only: bun can't call the system from an arm64 build, and arm64 Windows runs x64.
  releaseAsset: "weblab-windows-x64.exe",
  // A running program can be moved aside, not written over or removed.
  // What earlier updates moved aside goes once it no longer runs.
  replaceBinary(staged, running) {
    const old = `${basename(running)}.old-`;
    for (const name of readdirSync(dirname(running)).filter((file) => file.startsWith(old))) {
      try {
        rmSync(join(dirname(running), name));
      } catch {
        // Still running.
      }
    }
    const aside = `${running}.old-${process.pid}`;
    renameSync(running, aside);
    try {
      renameSync(staged, running);
    } catch (error) {
      renameSync(aside, running);
      throw error;
    }
  },
};

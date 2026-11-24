/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Deliver a REAL Windows CTRL_BREAK_EVENT to one child process, and only it.
 *
 * Helper, not a suite: the leading underscore keeps run-all.ts from collecting it.
 *
 * Node cannot do this on its own. On Windows, libuv's process.kill() emulates
 * only SIGINT/SIGTERM/SIGKILL, all as TerminateProcess (no handler ever runs),
 * and spawn({ detached: true }) adds DETACHED_PROCESS, so the child has no
 * console to receive a console control event at all.
 *
 * So a small PowerShell host does it with the real Win32 calls:
 *
 *   1. CreateProcessW(..., CREATE_NEW_PROCESS_GROUP) starts the server child in
 *      its OWN console process group, on the helper's console. Its stdout and
 *      stderr go to a log FILE (an inheritable handle); the helper first clears
 *      the inherit flag on its own std handles, so the child never holds the
 *      runner's pipes open.
 *   2. On the cue line "BREAK" on stdin it calls
 *      GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, childPid). A non-zero group id
 *      reaches ONLY the processes in that group, so the helper and the runner
 *      are never signalled.
 *   3. It prints "EXIT <code>" when the child ends, then exits itself.
 *
 * The helper is spawned with windowsHide, which gives it a windowless console of
 * its own, separate from the runner's: even a stray event could not reach
 * run-all. If stdin closes (the runner is gone) it terminates the child, so a
 * crashed runner cannot leak a server.
 *
 * Protocol on the helper's stdout, one line each:
 *   PID <n>            the child started
 *   SENT <ok> <err>    GenerateConsoleCtrlEvent's BOOL result and GetLastError
 *   EXIT <code>        the child's exit code (unsigned; 3221225786 = 0xC000013A,
 *                      the "killed by Ctrl+Break/Ctrl+C" status)
 *   ERROR <detail>     the helper could not start the child
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree } from "./_portableSpawn.ts";

const HELPER_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Tina4CtrlBreak {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);

    const uint CTRL_BREAK_EVENT = 1;
    const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    static readonly object Gate = new object();

    static void Say(string line) {
        lock (Gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }

    static IntPtr OpenInheritable(string path, uint access, uint disposition) {
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(sa);
        sa.bInheritHandle = true;
        return CreateFileW(path, access, 3 /* share read|write */, ref sa, disposition, 0x80, IntPtr.Zero);
    }

    public static int Run(string commandLine, string cwd, string logPath) {
        // Our own std handles are the runner's pipes. bInheritHandles=TRUE below
        // would hand them to the child, which would then hold the runner's pipe
        // open for its whole life. Only the log and NUL handles may cross.
        foreach (int which in new int[] { -10, -11, -12 }) SetHandleInformation(GetStdHandle(which), 1, 0);

        IntPtr log = OpenInheritable(logPath, 0x40000000 /* GENERIC_WRITE */, 2 /* CREATE_ALWAYS */);
        IntPtr nul = OpenInheritable("NUL", 0x80000000 /* GENERIC_READ */, 3 /* OPEN_EXISTING */);
        if (log == new IntPtr(-1) || nul == new IntPtr(-1)) {
            Say("ERROR CreateFileW " + Marshal.GetLastWin32Error());
            return 2;
        }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.dwFlags = 0x100; // STARTF_USESTDHANDLES
        si.hStdInput = nul;
        si.hStdOutput = log;
        si.hStdError = log;
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, cwd, ref si, out pi)) {
            Say("ERROR CreateProcessW " + Marshal.GetLastWin32Error());
            return 2;
        }
        CloseHandle(log);
        CloseHandle(nul);
        CloseHandle(pi.hThread);
        Say("PID " + pi.dwProcessId);

        IntPtr child = pi.hProcess;
        Thread waiter = new Thread(delegate () {
            WaitForSingleObject(child, 0xFFFFFFFF);
            uint code;
            GetExitCodeProcess(child, out code);
            Say("EXIT " + code);
            Environment.Exit(0);
        });
        waiter.IsBackground = true;
        waiter.Start();

        string line;
        while ((line = Console.In.ReadLine()) != null) {
            if (line == "BREAK") {
                bool ok = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, (uint)pi.dwProcessId);
                int err = ok ? 0 : Marshal.GetLastWin32Error();
                Say("SENT " + (ok ? "1" : "0") + " " + err);
            } else if (line == "KILL") {
                TerminateProcess(child, 1);
            }
        }
        // stdin closed: the runner is finished or gone. Never leave the child behind.
        TerminateProcess(child, 1);
        waiter.Join(5000);
        return 0;
    }
}
`;

const HELPER_PS = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition $env:TINA4_CTRLBREAK_CS",
  "exit [Tina4CtrlBreak]::Run($env:TINA4_CTRLBREAK_CMD, $env:TINA4_CTRLBREAK_CWD, $env:TINA4_CTRLBREAK_LOG)",
].join("\n");

/** Quote one argument for a Windows command line (MSVCRT / CommandLineToArgvW rules). */
function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += ch === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

export interface BreakableChild {
  /** The server child's pid (also its console process group id). */
  pid: number;
  /** Resolves with the child's exit code once it has ended. */
  exit: Promise<number>;
  /** True once the helper has reported the child's exit. */
  exited(): boolean;
  /** Send CTRL_BREAK_EVENT to the child's group; resolves with the helper's "SENT" line. */
  sendBreak(): Promise<string>;
  /** Force-kill the child and the helper. Safe to call repeatedly. */
  kill(): void;
}

/**
 * Start `argv` in its own console process group, its output in `logPath`.
 * Windows only: throws anywhere else.
 */
export function spawnBreakable(
  argv: string[],
  opts: { cwd: string; logPath: string; env: NodeJS.ProcessEnv },
): Promise<BreakableChild> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("spawnBreakable is Windows-only (CTRL_BREAK_EVENT)"));
  }
  const helper: ChildProcess = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HELPER_PS, "utf16le").toString("base64")],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...opts.env,
        TINA4_CTRLBREAK_CS: HELPER_CS,
        TINA4_CTRLBREAK_CMD: argv.map(quoteArg).join(" "),
        TINA4_CTRLBREAK_CWD: opts.cwd,
        TINA4_CTRLBREAK_LOG: opts.logPath,
      },
    },
  );

  let stderr = "";
  helper.stderr!.on("data", (c) => (stderr += c));

  const waiters: Array<{ prefix: string; resolve: (line: string) => void }> = [];
  let pid = 0;
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((r) => (resolveExit = r));

  let buffered = "";
  helper.stdout!.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    let nl: number;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line.startsWith("EXIT ")) {
        exitCode = Number(line.slice(5));
        resolveExit(exitCode);
      }
      const i = waiters.findIndex((w) => line.startsWith(w.prefix));
      if (i !== -1) waiters.splice(i, 1)[0].resolve(line);
    }
  });

  const nextLine = (prefix: string, timeoutMs: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ctrl-break helper: no "${prefix}" line in ${timeoutMs}ms; stderr: ${stderr.slice(-1500)}`)), timeoutMs);
      waiters.push({ prefix, resolve: (line) => { clearTimeout(timer); resolve(line); } });
    });

  const kill = (): void => {
    if (pid) killProcessTree(pid);
    try { helper.stdin!.end(); } catch { /* already closed */ }
    try { helper.kill(); } catch { /* already gone */ }
  };

  return new Promise((resolve, reject) => {
    helper.once("exit", (code) => {
      if (!pid) reject(new Error(`ctrl-break helper exited ${code} before starting the child; stderr: ${stderr.slice(-1500)}`));
    });
    Promise.race([nextLine("PID ", 60_000), nextLine("ERROR ", 60_000)]).then((line) => {
      if (line.startsWith("ERROR ")) {
        kill();
        reject(new Error(`ctrl-break helper: ${line}`));
        return;
      }
      pid = Number(line.slice(4));
      resolve({
        pid,
        exit,
        exited: () => exitCode !== null,
        sendBreak: () => {
          const sent = nextLine("SENT ", 10_000);
          helper.stdin!.write("BREAK\n");
          return sent;
        },
        kill,
      });
    }, (err) => { kill(); reject(err); });
  });
}

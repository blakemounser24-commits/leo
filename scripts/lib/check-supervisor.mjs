#!/usr/bin/env node
// Keep a stable process-group leader alive until CHECK stdio closes.
// Zero dependencies. Node 16+.

import { spawn } from "node:child_process";

const [shell, command, runnerArg] = process.argv.slice(2);
const runnerPid = Number(runnerArg);
if (!shell || command === undefined || !Number.isInteger(runnerPid) || runnerPid < 1) {
  console.error("unlazy-check-supervisor: expected resolved shell, CHECK command, and runner pid");
  process.exit(2);
}

// A CHECK must never outlive the gate-check that started it. On POSIX this
// supervisor runs detached as its own process-group leader, so when the runner
// dies without cleaning up (SIGKILL, a host shell timeout) nothing signals the
// group: the supervisor is reparented and the CHECK keeps running, and a CHECK
// that itself starts gate-check can multiply without bound. Linux has
// PR_SET_PDEATHSIG and macOS has kqueue NOTE_EXIT, but Node exposes neither,
// so polling the parent pid is the only portable zero-dependency signal. The
// runner passes its own pid, which also catches a runner that died while this
// process was still starting. On a change, SIGKILL the whole group: the
// CHECK's shell, its descendants, and this supervisor. Windows is not spawned
// detached and its cleanup goes through terminateProcessTree, so it is left
// unchanged.
if (process.platform !== "win32") {
  const runnerGone = () => {
    if (process.ppid !== runnerPid) process.kill(-process.pid, "SIGKILL");
  };
  runnerGone();
  setInterval(runnerGone, 1000).unref();
}

let child;
let spawnError = null;
try {
  child = spawn(command, {
    cwd: process.cwd(),
    shell,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  console.error("unlazy-check-supervisor: could not start CHECK: " + error.message);
  process.exit(127);
}

// Pipe instead of inheriting descriptors directly. Node's `close` event then
// waits for descendants that inherited the shell's stdout or stderr, keeping
// this detached supervisor alive as the original process-group identity.
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.once("error", (error) => { spawnError = error; });
child.once("close", (code, signal) => {
  if (spawnError) {
    console.error("unlazy-check-supervisor: CHECK spawn failed: " + spawnError.message);
    process.exitCode = 127;
    return;
  }
  if (Number.isInteger(code)) {
    process.exitCode = code;
    return;
  }
  console.error("unlazy-check-supervisor: CHECK ended by " + (signal || "unknown signal"));
  process.exitCode = 1;
});

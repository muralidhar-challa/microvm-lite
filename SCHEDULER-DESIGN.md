# Scheduler Design: shared-memory concurrency in blink

## Problem

microvm-lite's guest process model (`Fork()` in `blink-src/blink/syscall.c`,
`__EMSCRIPTEN__`-only) is **run-to-completion**: a forked child always runs
all the way to exit or execve before `Fork()` returns control to the parent.
There is no preemption point, so `window.vm.run()` can never report
`done:false` the way SQL_Chat's `useV86.ts` (the v86-backed oracle) does for
a command that's still running after its timeout — v86 launches every
command backgrounded (`sh script.sh & wait $!`) and, on timeout, detaches
from the wait while the job keeps running in the guest; a later
`readFile(output_file)` sees the eventually-complete output, and the real
pid lets a caller `kill` it later. `vm-host.js`'s pidfile-readback code
(`vm-host.js:257`, `if (!r.done && r.output_file && r.pid == null)`) is
already written and currently dead, waiting for `done:false` to ever happen.

A prior session fixed the last known correctness bug in the current
run-to-completion model (a stale `m->system->exited` flag silently killing
the whole process on a second independent fork — found via a native,
`lldb`-debuggable build of blink with `__EMSCRIPTEN__` forced). This doc
specifies the next step: a genuine cooperative scheduler.

## Architecture decision: literal shared memory

The scheduler gives a scheduled job **literal shared memory** with whatever
spawned it — not an independent address space. This is explicitly the same
model as real `pthread_create`/`CLONE_THREAD` (shared heap/globals, own
stack, live writes visible to both sides indefinitely), used as the single
general mechanism for **both**:

- real guest threading (a guest program calling `pthread_create` — currently
  unsupported, compiled out by `config.h`'s `DISABLE_THREADS`), and
- shell `&` / `window.vm.run()` timeout-backgrounding (dash's `cmd &`, which
  always uses `fork()`/`vfork()` at the syscall level, never
  `clone(CLONE_THREAD)` — a POSIX requirement, not a blink limitation, since
  only a separate process can later `exec()` a different program).

One scheduler, two spawn flavors sharing the same fiber-multiplexing
mechanism — they differ only in what gets duplicated at spawn time (fd table:
shared for threads, independently-copied for fork-style children — matching
real Linux `clone()` flag semantics) and how they're reaped (thread-join vs.
`wait4`). Neither flavor gets memory isolation: the existing
`EmSaveMem`/`EmRestoreMem` snapshot-restore trick stays scoped to the
**existing synchronous fast path only** (ordinary sequential commands that
never need to background) — it doesn't extend to scheduled jobs, and doesn't
need to, since scheduled jobs are meant to share memory, not have it undone.

This is real, novel C-level work on a component that has already proven
subtle and bug-prone even in its simpler form. The plan is phased so each
step is independently buildable and testable — via the native
`MVL_NATIVE_DEBUG` + `lldb` harness proved out in the prior session, plus the
existing `test/contract.spec.mjs`/`test/stress.spec.mjs` playwright suites —
before the next step depends on it.

## Grounding (verified in source)

- `Actor()` (`machine.c` ~2233-2249) is the per-instruction interpreter loop:
  `for (g_machine=mm, m=mm;;) { if (!attention) ExecuteInstruction(m); else
  CheckForSignals(m); }` — the only safe, existing per-instruction checkpoint
  to hook a scheduler yield into. Because yields only happen between fully
  completed guest instructions (never mid-instruction), cooperative
  interleaving over literally-shared memory is safe by construction — no
  guest instruction can observe a torn write from another job, even though
  there's no real hardware memory-ordering/barrier machinery involved.
- `RunMachineUntilExit(m)` (`machine.c` ~2280) — `sigsetjmp(m->onhalt,1)` +
  `Actor(m)`; reused as-is as each scheduled job's fiber body.
- **`SysSpawn`/`OnSpawn` (`syscall.c` ~1259-1274) is the reference
  implementation to adapt, not just a structural analogy.** Native blink's
  guest `clone(CLONE_THREAD|CLONE_VM|...)` already does exactly what's
  wanted here: `NewMachine(m->system, m)` — note `m->system`, the *same*
  System, not `NewSystem()` — creates a new `Machine` sharing the parent's
  page tables/heap/fds, gets its own register file and its own stack region
  (from the guest's explicit `stack` argument, the same mechanism `Fork()`
  already uses for musl's `posix_spawn`), then `pthread_create(&thread, &attr,
  OnSpawn, m2)` runs it concurrently. `OnSpawn` is `sigsetjmp` + `Blink(m)`.
  The scheduler's job-creation path for thread spawns is this function with
  `pthread_create` replaced by fiber creation. Currently unreachable because
  `config.h`'s `DISABLE_THREADS` compiles out `HAVE_THREADS`
  (`thread.h:4-5`: `#ifndef DISABLE_THREADS #define HAVE_THREADS`), so
  `SysSpawn` is never registered in the syscall table — a later phase
  re-enables registration under `__EMSCRIPTEN__` specifically, routed to the
  fiber scheduler instead of real pthreads.
- `Fork()` (`syscall.c` ~895) — today's run-to-completion path stays exactly
  as-is (including `EmSaveFds`/`EmSaveMem`/`EmRestoreFds`/`EmRestoreMem`) as
  the fast synchronous path for ordinary sequential commands. A fork/vfork
  that the JS side decides to background takes a **different** path: like
  `SysSpawn`, `NewMachine(m->system, m)` (shared memory), but with an
  **independently-copied fd table** (`EmSaveFds`-style duplication, reused
  for its dup-and-swap mechanics — but kept, not restored, for the job's
  whole lifetime, matching real `fork()`'s independent-but-initially-
  identical fd table semantics) and reaped via `wait4`/`g_em_children`
  rather than thread-join. If it calls `execve()`, `SysExecve`'s existing
  vfork-child branch already creates a genuinely separate `Machine`+`System`
  at that point (`m2 = NewMachine(NewSystem(...))`) — unchanged, and it's
  what ends the shared-memory window for the common case (`long_task.sh &`
  execs almost immediately).
- `g_em_children[EM_MAX_CHILDREN]` (`syscall.c` ~529) — existing
  exit-status stash for `wait4`; the scheduler changes the invariant around
  it (`wait4` on a not-yet-finished child must genuinely block/yield, not
  just fail to find a stashed status — currently `SysWait4` calls `echild()`
  when nothing's stashed).
- `struct Machine::killed`/`attention` (`machine.h` ~427, `CheckForSignals`
  in `machine.c`) — native blink's existing "interrupt this machine"
  mechanism; reused for `kill(pid)`.
- Feasibility: plain `-s ASYNCIFY` is single-continuation (one global
  unwind/rewind buffer) and cannot interleave two independent
  partially-executed stacks. Emscripten's **Fibers API**
  (`emscripten_fiber_init`/`emscripten_fiber_swap`) is built on top of
  Asyncify specifically for this and needs no extra build flag beyond the
  existing `-sASYNCIFY`. Known hazard: `g_machine` is `_Thread_local`
  (`machine.c:60`) and does **not** follow a fiber swap on the one real
  thread — the scheduler must manually reassign `g_machine` on every resume.

## Phased implementation

Each phase gate must pass (native `lldb` harness where noted, else
`bun test/contract.spec.mjs` / `test/stress.spec.mjs`) before starting the
next. New scheduler code lives in `blink/sched.c` + `blink/sched.h`, added to
the emcc source list in `blink/build.sh` alongside a `ucontext`-based shim
for the native debug build (Emscripten fibers don't exist natively).

**Phase 0 — context-switch shim, no behavior change.**
`SchedYield`/`SchedSwap` behind a thin abstraction: `emscripten_fiber_*`
under `__EMSCRIPTEN__`, `ucontext`/`swapcontext` under `MVL_NATIVE_DEBUG`.
Gate: a `sched_selftest()` swaps between two `ucontext` contexts sharing a
plain global (not per-context) counter — proving the shared-memory model at
the most trivial level — verified under `lldb` on the native harness.

**Phase 1 — fiber PoC in total isolation (no Machine, no shell).**
New export `em_fiber_selftest()`: 2 Emscripten fibers ping-pong a counter N
times, recording interleave order. Validates `emscripten_fiber_init`/
`emscripten_fiber_swap` actually work under this project's exact emcc flags
and worker environment — the single biggest open unknown. Gate: a
`contract.spec.mjs`-style playwright test asserts the recorded interleave
sequence.

**Phase 2 — two trivial Machines sharing one System, no dash.**
`em_sched_submit_thread(entry_fn, stack)` creates two `Machine`s via
`NewMachine(shared_system, parent)` (mirroring `SysSpawn` directly, no guest
ELF/shell involved yet) — each writes to a *shared* guest memory location
(not separate files) and the test asserts BOTH interleaved writes are
visible to a third read after both finish, proving literal shared-memory
visibility across the fiber swap. Also assert `g_machine` is correctly
reassigned on every swap (checked under native `lldb`). Gate: native harness
+ playwright.

**Phase 3 — real `CLONE_THREAD` support (re-enable `SysSpawn`).**
Register `SysSpawn` under `__EMSCRIPTEN__` (currently compiled out by
`DISABLE_THREADS`), routing its `pthread_create(OnSpawn, m2)` call through
`em_sched_submit_thread` from Phase 2 instead. A guest program that calls
`pthread_create` now gets genuine concurrent, shared-memory execution. Gate:
a small guest C test binary with two `pthread_create`d workers incrementing
a shared counter under a mutex (or observing each other's writes without
one, to explicitly test the "no torn writes across a yield" claim above) —
verified both natively and via `contract.spec.mjs`.

**Phase 4 — fork/vfork-backed background jobs (`{done:false, pid}`
contract), still no JS timeout wiring.** Same `NewMachine(m->system, parent)`
shared-memory spawn as Phase 3, but: (a) fd table is independently copied at
spawn time (reusing `EmSaveFds`'s dup-and-swap mechanics, kept rather than
restored for the job's lifetime — matching real `fork()`'s
independent-but-initially-identical fd table), and (b) `SysWait4`
(`syscall.c` ~4550) yields in a loop via the scheduler until the awaited
child is `DONE`, instead of `echild()`ing immediately. `Fork()`'s existing
snapshot/restore fast path stays untouched for everything else. Gate:
`sh -c 'sleep 1 & wait'` returns the correct exit code; full regression of
sequential (`A; B; C`) and pipeline commands through `contract.spec.mjs` +
`stress.spec.mjs` — the fast path must show zero behavior change.

**Phase 5 — wire the JS contract.** `doExecute` (`vm-worker.js`) is wired to
a scheduler tick loop (`em_sched_run(budget_ms)` called repeatedly from a JS
`setTimeout(0)` loop, not one giant Asyncify-suspended call — keeps the
browser responsive and avoids nesting Asyncify unwinds inside a fiber swap);
on timeout it detaches exactly like `useV86.ts`'s Ctrl+C-the-wait behavior
and returns `{done:false, output_file, pid}` while the job keeps running.
`doRun` stays on the legacy path for now. Gate: new `contract.spec.mjs` case
— a long-running command returns `done:false` with a real pid before it
finishes, a later `readFile(output_file)` eventually shows the completed
output, and a second concurrent `execute()` call returns `done:true`
normally while the first is still backgrounded.

**Phase 6 — kill.** `em_kill(pid, sig)` sets `Machine::killed`/`attention`
on the target job's `Machine`; `CheckForSignals` unwinds it via the existing
`HaltMachine`/`siglongjmp` path; the scheduler reaps it (frees the fiber
stack and, for fork-style jobs, its duplicated fd table; thread-style jobs
free only their own stack/registers since the System is shared and outlives
them) and stashes a `WIFSIGNALED` status for fork-style jobs. Exposed as the
guest `kill` applet (already in `vm-worker.js`'s `APPLETS` list) routed
through a real `SysKill`, and/or a dedicated `window.vm.kill(pid)` host API.
Gate: background a long `sleep`, kill its pid, confirm the wasm heap doesn't
grow per the existing `_stat()`/`stat` diagnostic message (`vm-worker.js`), a
follow-up status reports `WIFSIGNALED`, and a second concurrent job is
undisturbed.

Only after Phase 6 is green: migrate `doRun` off the legacy `callMainAsync`
path onto the scheduler too, and re-run the full regression suite.

## Explicitly out of scope for v1

- Genuine blocking pipe reads between two live jobs — keep the
  mkstemp/MEMFS-file-backed pipe (`SysPipe2`'s `__EMSCRIPTEN__` branch);
  reader still drains to EOF, no cross-job wake-on-writer-close.
- Fair scheduling — round-robin only, no priorities/nice. (Preemption of a
  busy loop with no syscalls mostly works for free from the instruction-count
  checkpoint, since there's no JIT — every instruction hits the counter.)
- A Machine simultaneously mid-`em_http_fetch` (Asyncify) *and* being
  fiber-swapped/backgrounded — don't background a job mid-fetch in v1.
- Full job control (SIGSTOP/SIGCONT, process groups, tty ownership,
  `fg`/`bg`) — only SIGTERM/SIGKILL-style `em_kill`.
- Real per-page copy-on-write divergence for fork-style jobs (the kind real
  Linux does via page-fault-triggered duplication) — v1 fork-style jobs share
  memory with no divergence at all, same as threads, for the whole window
  between `fork()` and either `execve()` (which replaces the address space
  entirely, ending the sharing) or `exit()`. This is a deliberate
  simplification matching the shared-memory decision above, not a punt to
  revisit by default — only worth reconsidering if a real workload needs a
  backgrounded child's writes to stay invisible to its parent.

## Critical files

- `blink-src/blink/machine.c` — `Actor` yield hook, `RunMachineUntilExit`,
  `Blink`.
- `blink-src/blink/syscall.c` — `Fork`, `SysSpawn`/`OnSpawn` (the reference
  pattern to adapt), `SysExecve` vfork branch, `SysWait4`, `g_em_children`.
- `blink-src/blink/machine.h` — `System::machines`, `Machine::killed`/
  `attention`.
- `blink-src/blink/config.h` — `DISABLE_THREADS` (a later phase conditionally
  re-enables `SysSpawn` registration under `__EMSCRIPTEN__` without fully
  removing this define, since the *real*-pthread path native blink uses for
  non-wasm builds stays disabled — only the wasm/fiber-routed path is new).
- `blink/stubs.c` — `em_main`/`em_last_exit`; new `em_sched_*` exports live
  here.
- `blink/build.sh` — emcc source list (add `sched.c`) and
  `EXPORTED_FUNCTIONS` (add the new `em_sched_*`/`em_kill` exports); the
  native `MVL_NATIVE_DEBUG` compile command (add the `ucontext` shim source).
- `src/vm-worker.js` — `doExecute`/`doRun`, `callMainAsync`, message
  protocol (unchanged shape, changed internals only).
- `src/vm-host.js` — the already-written, currently-dead pidfile-readback
  block (`vm-host.js:257`) that Phase 5 makes reachable.
- New: `blink/sched.c`, `blink/sched.h`.

## Verification

- Reuse the proven native-debug methodology: a native x86_64 debug build of
  blink with `-D__EMSCRIPTEN__ -DMVL_NATIVE_DEBUG` forced (real asserts, real
  `lldb` breakpoints/backtraces — production's `-DNDEBUG` silently swallows
  exactly the class of bug this codebase has repeatedly hit) as the primary
  gate for Phases 0-4.
- `bun test/contract.spec.mjs` and `test/stress.spec.mjs` (playwright) as the
  gate for Phases 5-6 and for regression-checking the untouched synchronous
  fast path at every phase.
- Full clean rebuild from a fresh `git checkout` before considering any
  phase's patch content final, proving the patch file reproduces the fix
  from scratch and isn't dependent on incidental local state.

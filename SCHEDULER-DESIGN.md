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

### Product priority (2026-07 update)

Ranked by what the product actually suffers from, to keep the remaining
phases pointed at value:

1. **Background jobs (`done:false` + pid + later readFile + kill)** — the
   SAMS backend intermittently takes 24s-10min on query execution
   (HAR-confirmed). Today a slow query blocks the whole VM (all other calls
   serialize behind it — see the `runExecQueued` note under "Near-term
   wins") and a host-side timeout loses the handle to work that is still
   running. This is the phase output that changes user experience, and it
   is the yardstick for Phase 5's design.
2. **True persistent interactive shell** — partly superseded since this doc
   was first written: the shipped emulated session (vm-worker
   `runShellCapture` session wrapper — exported WORKDIR/SESSION_ID plus
   env/cwd replay via `/tmp/.sess_<sid>.{env,cwd}`) already covers env+cwd
   persistence for the chat orchestrator. A live shell still adds shell
   functions/aliases/unexported vars, `$?` continuity, and honest terminal
   interactivity — a post-Phase-6 consumer (a persistent `sh` as a
   long-lived scheduled job fed via its stdin fd), no longer a driver.
3. **Guest `pthread_create`** — already delivered (Phase 3 DONE below).

Also load-bearing: **this design requires the interpreter.** Preemption
comes from `Actor()`'s per-instruction checkpoint (instruction count as
BEAM-style reduction count — a guest busy-loop with zero syscalls still
yields on budget, no guest cooperation needed, because cooperation lives a
layer below the guest). A wasm JIT backend, if ever built, would run
translated blocks between checkpoints and break preemption — any future
JIT work must be scheduler-aware, and the scheduler comes first.

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

## Blocking calls: the yield-and-recheck pattern, and `em_http_fetch`

Every green-thread runtime converts blocking operations into yield-and-poll
(Go's netpoller, BEAM's ports, asyncio's loop) — under this scheduler a
blocking host call stalls the ONE real OS thread every fiber shares, so
nothing else can run and nothing exists to wake the blocker. Two instances
of exactly this bug were already found and fixed with the same pattern
(cooperatively yield via the scheduler, recheck the condition, repeat):
`SysFutexWait` (Phase 3) and `SysNanosleep` (Phase 4), both gated on
`g_mvl_sched_active` so the never-scheduled path stays byte-identical.

**`em_http_fetch` is the third — and it is the flagship use case, not an
edge case.** An earlier draft of this doc listed "a Machine mid-
`em_http_fetch` being fiber-swapped" as out of scope. That exclusion cannot
survive contact with the goal: a slow `sams` query — the very thing
`{done:false, pid}` exists to background — spends nearly ALL of its time
inside the fetch. A fiber suspended in a plain Asyncify await cannot also
be fiber-swapped (the await unwinds to the JS event loop, not to a swap
point). Resolution, same shape as the futex/nanosleep fixes:

- For scheduled jobs (`g_mvl_sched_active`), `em_http_fetch` becomes
  **issue-then-poll**: post the proxy_request to JS, then loop
  `{ check per-request completion flag; MvlSchedYieldOnce(); }` until the
  JS side marks the response ready (the existing proxy timeout → 504
  synthesis stays, made configurable — see Near-term wins). No Asyncify
  await on this path at all, so the fiber is always swappable.
- The non-scheduled fast path keeps the existing Asyncify-await
  implementation unchanged.
- JS side: `proxy_response` handling stores the response and sets the flag
  instead of resolving an await — a small, mechanical change in
  `vm-worker.js`.

This is a **prerequisite for Phase 5**, alongside the Phase 4
memory-isolation gap: without it, backgrounding detaches from exactly the
jobs that never yield.

## Near-term wins independent of the remaining phases (do these regardless)

- **Proxy 30s cap vs. legitimately slow queries.** `emHttpFetch` in
  `src/vm-worker.js` synthesizes a 504 after a hard-coded 30 000 ms, but
  some predefined queries legitimately run 1-2 min (the sams CLI's own
  per-attempt timeout defaults to 240s, and the backend hangs up to
  10 min). On microvm-lite ANY query >30s currently dies at the proxy
  regardless of sams settings. Make the cap configurable from the init
  message with a default comfortably above 240s.
- **"Started"-message stepping stone (optional).** The worker posts
  `{type:"started", id, output_file, pid}` as soon as the capture file is
  chosen; on host-side `_call` timeout, `vm.run` resolves
  `{done:false, output_file, pid}` instead of rejecting. Result stays
  retrievable after a timeout TODAY, with the honest limitation that later
  commands still queue behind the running one until it finishes. ~80% of
  the background-jobs UX for ~5% of the effort; Phase 5 replaces its
  internals, not its contract.
- **Context: `runExecQueued` (vm-worker, commit 2d2b825).** All guest
  executions now serialize through one promise chain — the correctness
  stopgap for the single-continuation world (two concurrent `em_main`
  calls corrupted Asyncify and wedged the worker permanently, observed
  live). Phase 5's tick loop subsumes and retires it.

## Phased implementation

Each phase gate must pass (native `lldb` harness where noted, else
`bun test/contract.spec.mjs` / `test/stress.spec.mjs`) before starting the
next. New scheduler code lives in `blink/sched.c` + `blink/sched.h`, added to
the emcc source list in `blink/build.sh` alongside a `ucontext`-based shim
for the native debug build (Emscripten fibers don't exist natively).

**Phase 0 — context-switch shim, no behavior change. DONE.**
`SchedMakeContext`/`SchedSwap` behind a thin abstraction in
`blink/mvl_sched.c`+`mvl_sched.h` (named `mvl_sched.*`, not `sched.*` — a
plain `sched.h` shadows the system `<sched.h>` that `throw.c`'s
`sched_yield()` needs, since `blink/` is on the include path): `ucontext`/
`swapcontext` under `MVL_NATIVE_DEBUG`, `emscripten_fiber_*` under
`__EMSCRIPTEN__`. Gate: `SchedSelftest()` swaps between two `ucontext`
contexts sharing a plain global (not per-context) counter — proving the
shared-memory model at the most trivial level — verified under `lldb` on the
native harness (`test/native-sched-selftest.sh --lldb`): breakpoints inside
the shared body show alternating `who='A'`/`who='B'` on the same OS thread.

**Phase 1 — fiber PoC in total isolation (no Machine, no shell). DONE.**
`em_fiber_selftest()`/`em_fiber_selftest_log()` (same `SchedSelftest()` body,
now exercised through the real `__EMSCRIPTEN__` backend) exported and driven
by `test/fiber-selftest.spec.mjs` — a live-browser playwright test, not just
a C-side self-check. Validated `emscripten_fiber_init`/`emscripten_fiber_swap`
actually work under this project's exact emcc/Asyncify flags — the single
biggest open unknown — and it does, but only after fixing two real bugs the
naive port from `ucontext` doesn't warn you about:

- **A context that's only ever a *target* (never created via
  `SchedMakeContext`) must still be explicitly initialized.** `ucontext`'s
  `swapcontext(&from->uc, &to->uc)` populates `from` unconditionally, so a
  zeroed `ucontext_t` "just works" as a future swap target. Emscripten
  Fibers don't: `emscripten_fiber_t`'s `finishContextSwitch` distinguishes
  "fresh entry point" from "resume" via a `stack_base`/`stack_max` pair that,
  on a never-initialized struct, reads as `0`/`0` — swapping into it sets
  the wasm stack limits to `[0,0]` and the very next stack operation traps
  `unreachable`. Fixed by adding `SchedInitCurrentContext(ctx)`
  (`emscripten_fiber_init_from_current_context` / a harmless `getcontext`),
  which MUST be called on any context — typically the scheduler's own "main"
  context — that a fiber swaps back into but that was never itself created
  via `SchedMakeContext`.
- **The entry function's actual wasm-level type must be `void(void*)`,
  exactly — casting a C function pointer does not change it.** A
  `void(void)` function cast to `void(*)(void*)` and handed to
  `emscripten_fiber_init` traps with "function signature mismatch" the
  moment Fibers calls it through the wasm function table via a typed
  `dynCall_vi` — wasm enforces function-table call signatures at the type
  level, unlike native ABIs where an unused extra argument is silently
  ignored. Fixed by making `SchedMakeContext`'s `entry` genuinely take a
  `void *arg` everywhere (both backends), which also meant giving the
  `ucontext` backend its own per-context entry/arg storage and a shared
  trampoline (`makecontext`'s varargs are int-sized and can't portably carry
  a pointer on LP64) rather than passing the pointer through `makecontext`
  directly.

`ASYNCIFY_STACK_SIZE` was NOT the issue, despite Emscripten's own error
message suggesting it — a red herring worth remembering before chasing it
again in a later phase.

Gate: `bun test/fiber-selftest.spec.mjs` — live Chromium, real
`dist/blink.js`/`blink.wasm`, asserts the exact interleaved log string
(`"ABABABABABABABABABAB"`) and reruns the whole thing a second time in the
SAME module instance to confirm no leftover Asyncify state corrupts a later
run (the real scheduler will call this repeatedly in one long-lived worker).
`contract.spec.mjs` (17/17) and `dist-smoke.spec.mjs` regression-checked
after wiring `mvl_sched.c` into the real `blink/build.sh` — zero behavior
change, cold boot still ~76-96ms.

**Phase 2 — two trivial Machines sharing one System, no dash. DONE.**
`blink/mvl_sched_phase2_test.c`'s `MvlSchedPhase2Test()` (exported as
`em_sched_phase2_test()` for the wasm side) creates two `Machine`s via
`NewMachine(system, parent)` (mirroring `SysSpawn` directly — `m2 =
NewMachine(sys, m1)` shares `sys`, `memcpy`s `m1`'s register state) — no
guest ELF/shell involved. Each writes a byte to a *shared* guest memory page
(via `CopyToUser`/`CopyFromUser`, not separate files) across a fiber swap,
and a third read (from the original, never-fibered context, after both
fiber bodies finish) sees BOTH writes — proving literal shared-memory
visibility, not just mid-flight cross-visibility.

Two real things this surfaced, beyond the `g_machine` hazard it was
explicitly designed to catch:

- **Standing up a `Machine`/`System` pair outside blink's normal ELF-load
  bootstrap needs one explicit step the loader normally hides.**
  `ReserveVirtual` walks page tables starting from `system->cr3`, which is
  ordinarily allocated by `loader.c:782` (`m->system->cr3 =
  AllocatePageTable(m->system)`) as part of loading a guest binary. Skip the
  loader (as Phase 2 does — no ELF, no shell) and `cr3` stays `0`, so the
  very first `ReserveVirtual` call trips `unassert(s->real)` inside
  `GetPageAddress` — `s->real` is a *real-mode* (16-bit) memory region, only
  ever allocated when `NewSystem`'s mode is `XED_MODE_REAL`; our test
  correctly uses `XED_MACHINE_MODE_LONG` (64-bit), so `s->real` is
  legitimately null, and the actual bug is the missing `AllocatePageTable`
  call, not a bad assert. Fixed by calling it explicitly right after
  `NewSystem`, mirroring what `loader.c` does. Found via native `lldb`
  (`unassert` compiles to a real trap under `-DNDEBUG`... except this
  harness doesn't set that for asserts specifically — `unassert` always
  fires — so the backtrace pointed straight at `GetPageAddress` →
  `ReserveVirtual` → `main`).
- **Native linking of the full blink source tree (needed here, unlike
  Phase 0/1's self-contained `mvl_sched.c`) pulls in symbols that are
  reachable at native-link time but not at real wasm-build time.**
  `FastCall`/`FastCallAbs`/`FastLeave`/`Jitter` (JIT-only, `stack.c` calls
  them unconditionally even though `DISABLE_JIT` makes them unreachable at
  runtime — a known issue from the earlier debugging session) plus a NEW
  one: `FixXnuSignal` (`xnu.c`, deliberately excluded from the file list),
  referenced unconditionally by `blink.c`'s `OnFatalSystemSignal` — this
  reference is normally dead code under emcc (which never defines
  `__APPLE__`), so the real wasm build never hits it; native clang on macOS
  does. Fixed with trivial stubs in
  `blink/native-debug/native-stubs.c` (link-only, never part of the wasm
  build). Also needed `-D_DARWIN_C_SOURCE` alongside `-D_XOPEN_SOURCE=600`
  — the latter alone hides `AT_FDCWD`/`O_CLOEXEC`/`openat`/`MAP_ANONYMOUS`
  on macOS's headers.

Gate: `test/native-phase2-selftest.sh` (native `lldb` — confirmed via actual
breakpoint inspection that `g_machine == g_m2` immediately after resuming
into `Body1`, i.e. still stale from `Body2`, exactly the hazard the design
calls out, before the next line corrects it) + `bun
test/phase2-selftest.spec.mjs` (live Chromium, real `dist/blink.js`, passed
on the first try — no new wasm-specific bugs this time, unlike Phase 1).
`contract.spec.mjs`/`dist-smoke.spec.mjs` regression-checked after wiring
`mvl_sched_phase2_test.c` into `blink/build.sh` — zero behavior change, cold
boot ~86ms.

**Phase 3 — real `CLONE_THREAD` support (re-enable `SysSpawn`). DONE.**
`SysSpawn` now compiles and works under `__EMSCRIPTEN__` too (was
`#ifdef HAVE_THREADS`-only, still compiled out by `DISABLE_THREADS` for
non-wasm native builds — that's unchanged). This was the first phase to
touch existing blink files rather than only add new ones, and to require a
genuine round-robin scheduler (new `blink/mvl_dispatch.c`+`.h`) rather than
Phase 0-2's point-to-point fiber swapping — a guest program's
`pthread_create()` now gets real preemptive, shared-memory concurrency with
whatever spawned it, not just correct-looking output.

**Design**: `struct MvlThread` (a wrapper this module owns — deliberately
does NOT add fields to `struct Machine`, keeping the change additive) holds
a `Machine*`, a `SchedCtx` fiber, a host fiber stack, and a `next` pointer
forming a circular ring. `Actor()`'s per-instruction loop (`machine.c`)
gets one new line: `if (g_mvl_sched_active) MvlSchedMaybeYield();` — a
single global bool read when nothing's ever been spawned (the
overwhelming common case), a counter-increment-and-compare
(`MVL_YIELD_PERIOD` = 4096 instructions) once something has. `SysSpawn`'s
`__EMSCRIPTEN__` branch (`syscall.c`) keeps ALL of its existing flag
validation and `NewMachine(m->system, m)` call unchanged — only the very
last step (`pthread_create(OnSpawn, m2)`) is swapped for
`MvlSchedSpawnThread(m2)`, which lazily captures the calling machine as the
ring's "main" member on first use (`SchedInitCurrentContext`, no separate
init call needed from `blink.c`'s bootstrap) and splices `m2` in as a new
ring member. `SysExit`'s `__EMSCRIPTEN__` branch mirrors the
`HAVE_THREADS` branch's *intent* (a non-orphan thread exits without
killing the process) but not its mechanism: there's no real pthread to
`pthread_exit()` out of, so it calls `ClearChildTid` (fires the
`FUTEX_WAKE` a waiting `pthread_join()` needs — unchanged, reused as-is)
then `HaltMachine(m, kMachineExitTrap)`, which `siglongjmp`s straight back
into that thread's own driver loop (`MvlThreadEntry`), which marks it done
and permanently unlinks it from the ring. `m` is deliberately never freed
— real cleanup is Phase 6's job; this leaks, doesn't corrupt.

**A load-bearing bug found by just thinking through the model, confirmed
before it could bite**: `SysFutexWait`'s existing implementation calls
`pthread_cond_timedwait()` on contention — correct for real
`HAVE_THREADS` (each guest thread is a real OS pthread; blocking one
doesn't block the others) but fatal under the fiber model, where every
"thread" shares the ONE real OS thread — blocking it would stall the
entire scheduler, not just the waiter, and nothing else exists to wake it.
Fixed with a parallel `__EMSCRIPTEN__`-gated, `g_mvl_sched_active`-gated
branch that cooperatively yields (`MvlSchedYieldOnce`, unconditional
single swap, vs. `MvlSchedMaybeYield`'s periodic check) and rechecks the
condition instead of blocking — same retry-loop contract, `tick` set to
real wall-clock time (not the polling-interval stepping the original path
uses) so the caller's own deadline check still fires correctly for timed
waits. This is exactly the class of bug `pthread_mutex_lock` contention
would have hit immediately in the guest test below.

**A second real bug, found empirically**: the guest test binary ran but
produced NO output at all (clean exit, no error) the first time. Root
cause: `blink.c`'s `Exec()` skips `AddStdFd` (registering guest fds 0-2)
under `#ifndef __EMSCRIPTEN__` — correct for the real wasm build
(Emscripten's own runtime wires up fds 0-2 automatically) but the native
`MVL_NATIVE_DEBUG` harness forces `__EMSCRIPTEN__` too (to exercise
blink's wasm-only code paths under `lldb`) and has no such runtime, so
`SysWrite` (`if (!fd) return -1;`) silently fails on every write to
stdout/stderr. This exact issue was hit and *reverted* in an earlier
session because a broader fix broke the real wasm build. Fixed narrowly
this time: `#if !defined(__EMSCRIPTEN__) || defined(MVL_NATIVE_DEBUG)`
instead of `#ifndef __EMSCRIPTEN__` — `MVL_NATIVE_DEBUG` is never defined
in the shipped wasm build, so this cannot reproduce that regression; it
only changes behavior for the native debug harness, which had no working
stdout at all before this.

**Gate, verified two ways, both green:**
- `test/native-phase3-pthread-selftest.sh` — a REAL guest binary
  (`blink/native-debug/pthread-counter-test.c`, cross-compiled with
  `x86_64-linux-musl-gcc`, unmodified musl `pthread_create`/
  `pthread_mutex_lock`/`pthread_join`) run through a native blink CLI
  build (blink.c's real `main()`, not a custom test driver) with the
  scheduler linked in: two threads incrementing a shared counter 20,000
  times each under a mutex, joined, checked — `PASS: counter=40000`.
  Passed on the first real attempt once the fd fix landed. **Critically,
  a mutex-protected counter test alone can't distinguish genuine
  concurrency from accidentally-correct sequential execution** — both
  produce the right final total. Verified the difference directly under
  `lldb`: a breakpoint on `MvlSchedSwapToNext`, hit repeatedly, shows
  `g_mvl_current` cycling through three distinct addresses (main, worker1,
  worker2) in a *repeating* round-robin — concrete proof of real,
  continuing preemption during the loop, not one thread running to
  completion before the next starts.
- `test/phase3-pthread-selftest.spec.mjs` — the SAME guest binary, but run
  through the actual production contract: `window.vm.writeFile(...,
  {mode: "0755"})` + `window.vm.execute(...)` against the real
  `dist/blink.js`, live Chromium, real Emscripten Fibers — passed on the
  first try. Reran twice more in the same long-lived worker instance (the
  scheduler's per-command reset, `MvlSchedReset`, wired into the existing
  `em_reset_children()` hook) and confirmed an ordinary non-threaded
  command still works correctly afterward. `contract.spec.mjs` (17/17),
  `dist-smoke.spec.mjs`, `fiber-selftest.spec.mjs`, and
  `phase2-selftest.spec.mjs` all still pass unchanged — zero regression on
  every earlier phase's gate and the original synchronous fast path, cold
  boot still ~100ms.

**Known gaps, deliberately deferred (not silently missed):**
- A thread hitting a fatal signal (SIGSEGV etc.) is treated the same as a
  clean exit by `MvlThreadEntry` — silently ends the fiber rather than
  propagating the signal properly.
- Per-fiber signal masks aren't preserved across swaps — `pthread_sigmask`
  affects the one real OS thread all fibers share, so one fiber's mask
  change is visible to all others. Doesn't matter for the current gate (no
  guest signal masking); would need real per-`MvlThread` mask save/restore
  in `MvlSchedSwapToNext` before this carries a guest workload that uses
  signals.
- No real memory cleanup on thread exit (`m`/the fiber stack both leak) —
  intentional, Phase 6's job.
- A spawned thread calling `exit_group()` (not `exit()`/returning from its
  function) still goes through the ordinary `SysExitGroup` path, untested
  against the scheduler.

**Phase 4 — fork/vfork-backed background jobs. PARTIALLY DONE — literal
gate passes, zero regression, but a real architectural limitation remains
and is NOT safe for production background-job use yet. Read the whole
section before building on this.**

**What changed.** `Fork()`'s `__EMSCRIPTEN__` implementation was rewritten
to route through the scheduler instead of running synchronously to
completion: `m2 = NewMachine(m->system, m)` (same as Phase 3's `SysSpawn`
— shared memory), then `MvlSchedSpawnWithEntry(m2, EmForkChildEntry,
fds_list)` instead of the old `RunMachineUntilExit(m)` reusing the SAME
Machine for both parent and child. This is a bigger, riskier change than
Phases 0-3: it's the first phase to modify an EXISTING, heavily-used
function (`Fork()`) rather than only add new files, and it replaces the
`EmSaveMem`/`EmRestoreMem`/`EmSaveFds`/`EmRestoreFds`/`RunMachineUntilExit`
synchronous fast path for every fork/vfork call, not just backgrounded
ones — a deliberate unification (dash's own choice of whether to `wait()`
immediately, which it always does correctly, is what makes sequential
`cmd1; cmd2` behave identically to before while `cmd &` now genuinely
backgrounds).

**Four real bugs found and fixed** (each confirmed via native `lldb`, not
guessed):

1. **Shared-stack corruption.** A plain `fork()`/`vfork()` (no explicit
   `clone()` stack argument — the common case) left `m2->sp` equal to the
   parent's `sp`, via `NewMachine`'s memcpy. Correct for real `vfork()`
   (the parent is *suspended* until the child execve()s/exits — only one
   of them ever runs), wrong here: the child now runs *concurrently*, so
   both push/pop the identical stack addresses simultaneously. Confirmed
   via `lldb`: `FindPageTableEntry` crash-looping on garbage addresses
   within microseconds of the fork. Fixed by giving the child its own
   stack region (`ReserveVirtual`) and copying the parent's live stack
   bytes into it, relocating `sp` by the same offset.
2. **`ReserveVirtual(virt=0)` misuse.** Passing `virt=0` does NOT mean
   "auto-place" outside `HasLinearMapping()`'s branch — confirmed via
   `lldb` it returns the literal address 0, silently colliding with
   low/reserved memory. `SysMmap`'s own `addr=0` handling (`syscall.c`
   ~2108) shows the real pattern: resolve a free address via
   `FindVirtual()` first, then pass that to `ReserveVirtual()`.
3. **Argument-unwrapping bug.** `mvl_dispatch.c`'s spawn machinery always
   passes the internal `struct MvlThread` wrapper as the fiber's `void*`
   arg, never the `Machine*` directly — `MvlThreadEntry` (Phase 3) already
   knew this. The new caller-supplied entry (`EmForkChildEntry`) cast
   `arg` straight to `struct Machine*`, which was actually the wrapper;
   since the wrapper's `m` field and `Machine`'s `ip` field both sit at
   offset 0, the misread silently produced a plausible-looking pointer
   (the wrapper's own address, read as if it were `m->ip`) instead of
   crashing immediately — which is exactly why it took real `fprintf`
   tracing, not just `lldb` stepping, to spot. Fixed by making
   `MvlSchedSpawnWithEntry`'s contract genuinely pass `Machine*` to the
   caller's entry (an internal trampoline in `mvl_dispatch.c` does the
   real unwrap), and documented the exact failure mode so it doesn't
   recur.
4. **Blocking `nanosleep()`.** Same class of bug as the Phase 3 futex fix,
   different syscall: `SysNanosleep` calls real blocking `nanosleep()` for
   up to the full requested duration — fine when every guest thread is a
   real OS pthread, fatal when every fiber shares the one real OS thread a
   blocking call stalls entirely. Fixed with the same cooperative
   yield-and-recheck pattern, gated on `g_mvl_sched_active` so the
   untouched path is byte-identical when nothing's ever been scheduled.

**What's verified working**, both natively (`lldb`) and through the real
production contract in a live browser (`window.vm.execute` against the
actual `dist/blink.js`):
- The literal stated gate — `sh -c 'sleep 1 & wait'` — returns the correct
  exit code, confirmed with correct ~1s timing (not synchronously blocked).
- Sequential multi-fork commands (`cmd1; cmd2`) run correctly and produce
  correct output, matching pre-Phase-4 behavior exactly.
- `contract.spec.mjs` (17/17), `dist-smoke.spec.mjs`,
  `fiber-selftest.spec.mjs`, `phase2-selftest.spec.mjs`, and
  `phase3-pthread-selftest.spec.mjs` all pass unchanged — **zero
  regression** on every earlier phase's gate and the original synchronous
  fast path.

**What's NOT safe yet: real memory isolation for concurrently-scheduled
fork children.** Confirmed with a controlled, repeatable experiment:
`toybox echo A & wait; echo EXIT:$?` on ONE line (dash reads the whole
line before executing any of it, so the child never runs concurrently
with a parent that's also doing memory-touching work) works correctly.
The exact same command split across TWO lines — forcing dash to read a
*second* script line from the script file while the backgrounded child
is still alive and scheduled — reliably crashes (`SIGSEGV`, the top-level
machine executing at a garbage `pc`). This is NOT one of the four bugs
above; it reproduces identically before and after fixing all four,
including after building genuine per-fiber fd table independence (a real
fix for a real, separate bug — see below) specifically to rule out fd
sharing as the cause.

The root cause is the scheduler's shared-memory design itself, chosen
deliberately back in Phase 0-3 and explicitly written into this doc's
"Explicitly out of scope for v1" section: fork-style children share
memory with **zero copy-on-write divergence**. That was a reasonable bet
when the accepted risk was "a backgrounded child's pre-execve writes
might leak to the parent" (rare, narrow window, usually resolved by a
near-immediate `execve()`). It's a much bigger problem now that it's
concretely observed as "the *parent's own* unrelated work (reading its
next script line into its own buffers) gets corrupted by a totally
unrelated concurrently-scheduled child touching the same unisolated
address space" — not a narrow edge case, but the ordinary shape of any
multi-line script that backgrounds something. Fixing this for real means
bringing back some form of memory isolation for fork children that's
compatible with genuine interleaving (both sides actively running, not
one suspended while the other mutates) — a materially harder problem than
`EmSaveMem`/`EmRestoreMem`'s snapshot/restore, which only works because
the old model was synchronous (never two sides truly concurrent). Scoping
that fix is real design work for a future session, not a bug to patch
blind.

**A related, likely-connected symptom**, found while validating the gate
through the real VM contract: `window.vm.execute("sh -c 'sleep 1 & wait; echo EXIT:$?'")`
completes with the correct ~1s timing but returns **empty output** — the
inner shell's own stdout write appears not to reach the worker's capture
mechanism in this specific nested-shell-plus-backgrounding shape. Not
separately root-caused; worth investigating together with the memory-
isolation gap above, since both are manifestations of "concurrent
scheduling exposes gaps in resources this scheduler currently shares
uncritically" (memory for the crash; very possibly fd-table capture
plumbing interacting with the new independent-fds mechanism for this one).

**Also newly built** (a real, separately-useful fix, verified via the
one-line-vs-two-line experiment above to NOT be the memory-isolation
root cause, but load-bearing on its own): per-fiber fd table
independence. `struct Fds` lives on `struct System`, bundled with the
page tables that make shared memory work — there's no way to share
memory with a fork child but keep fds independent without either
splitting that struct (a much bigger change) or transparently swapping
`fds.list` in and out on every scheduler context switch, which is what
was built: `MvlSchedSpawnWithEntry` now takes a `fds_list` parameter (a
duplicate of the parent's fds at fork time, built by a new
`EmDupFdsForChild` helper mirroring `EmSaveFds`'s dup technique but
building a genuinely separate list instead of a save-for-later-restore
array), and `mvl_dispatch.c`'s swap path installs the right list — a
fork child's own, or the canonical shared one for the main/thread-style
fibers — on every swap, symmetric with the existing `g_machine`
save/restore. This is real, needed groundwork regardless of the memory
gap; it's just not sufficient by itself.

**Recommendation:** do not enable Fork()'s new concurrent path for
anything beyond the verified-safe shapes above (single background job
immediately followed by `wait` on the same logical statement, or
sequential non-backgrounded commands) until the memory-isolation gap is
addressed. Phase 5 (JS contract wiring for `{done:false, pid}`) should
wait for that work, not build on top of a known-corruptible foundation.

**Phase 5 — wire the JS contract. TWO HARD PREREQUISITES, in order:
(a) the Phase 4 memory-isolation gap (a concurrently-scheduled fork child
corrupts the parent's unisolated address space — see Phase 4's findings;
real design work, not a patch), and (b) the `em_http_fetch` issue-then-poll
conversion (see "Blocking calls" above — without it, backgrounding cannot
detach from exactly the fetch-bound jobs that motivate the feature).**
`doExecute` (`vm-worker.js`) is wired to
a scheduler tick loop (`em_sched_run(budget_ms)` called repeatedly from a JS
`setTimeout(0)` loop, not one giant Asyncify-suspended call — keeps the
browser responsive and avoids nesting Asyncify unwinds inside a fiber swap);
on timeout it detaches exactly like `useV86.ts`'s Ctrl+C-the-wait behavior
and returns `{done:false, output_file, pid}` while the job keeps running.
This retires the interim `runExecQueued` serialization queue.
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
- ~~A Machine simultaneously mid-`em_http_fetch` (Asyncify) and being
  fiber-swapped/backgrounded~~ — REMOVED from this list: it is the flagship
  use case (backgrounding a fetch-bound `sams` query) and is now a designed
  component — see "Blocking calls: the yield-and-recheck pattern, and
  `em_http_fetch`", a stated prerequisite for Phase 5.
- Full job control (SIGSTOP/SIGCONT, process groups, tty ownership,
  `fg`/`bg`) — only SIGTERM/SIGKILL-style `em_kill`.
- Real per-page copy-on-write divergence for fork-style jobs (the kind real
  Linux does via page-fault-triggered duplication) — **status changed by
  Phase 4's findings.** The original bet ("share memory with no divergence;
  only revisit if a workload needs a child's writes invisible to its
  parent") is falsified: the observed failure is not leaked writes but the
  parent's own unrelated buffers being corrupted by a concurrently-
  scheduled child in ordinary multi-line scripts (repeatable SIGSEGV — see
  Phase 4). SOME form of memory isolation for concurrently-scheduled fork
  children is therefore a hard prerequisite for Phase 5, and scoping it
  (full CoW vs. targeted isolation of the guest stack/heap regions vs.
  restricting concurrency to post-execve children, which already get a
  separate System) is the next real design task. Full Linux-grade
  page-fault CoW machinery remains out of scope unless that scoping
  concludes it's the only correct option.

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

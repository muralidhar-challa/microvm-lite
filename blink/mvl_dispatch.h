#ifndef MVL_DISPATCH_H_
#define MVL_DISPATCH_H_
// Real CLONE_THREAD support (SCHEDULER-DESIGN.md, Phase 3): a minimal
// round-robin scheduler giving spawned guest pthreads genuine preemptive,
// shared-memory concurrency with whatever spawned them, via the
// mvl_sched.c fiber primitives. __EMSCRIPTEN__-only; never linked into a
// non-wasm build. Deliberately does NOT touch `struct Machine` — thread
// bookkeeping lives entirely in `struct MvlThread`, a wrapper this module
// owns, to keep the change surface additive and isolated.
#include "blink/machine.h"

// True iff there's more than the one (implicit "main") thread alive right
// now. Checked on EVERY guest instruction from Actor()'s hot loop, so it
// must stay a plain global bool read — no locking, no function call — for
// the overwhelmingly common case (no thread ever spawned this command) to
// cost as close to nothing as possible.
extern bool g_mvl_sched_active;

// Called from Actor()'s per-instruction loop. Near-zero cost when
// g_mvl_sched_active is false (the existing synchronous fast path, and any
// command that never calls pthread_create).
void MvlSchedMaybeYield(void);

// Unconditionally gives another ready thread a turn, once, then returns —
// unlike MvlSchedMaybeYield's periodic instruction-count check. Used by
// SysFutexWait (syscall.c) as the cooperative substitute for
// pthread_cond_timedwait: blocking the one real OS thread there would
// stall every fiber, not just the waiter, since nothing else exists to
// wake it. Only call this when g_mvl_sched_active is true (callers already
// check, matching MvlSchedMaybeYield's contract) — with nothing else in
// the ring it would just return immediately, but the caller's g_machine
// bookkeeping assumes a real thread exists to hand off to.
void MvlSchedYieldOnce(void);

// SysSpawn's __EMSCRIPTEN__ implementation calls this once `m2` (a fresh
// Machine sharing `m`'s System, already fully set up by NewMachine +
// SysSpawn's normal validation/flag handling) is ready to start running
// concurrently. Lazily captures the CALLING machine as the scheduler's
// "main" thread on first use (SchedInitCurrentContext) — no separate init
// call needed from blink.c's bootstrap. Returns 0 on success, -1 on
// allocation failure (caller should treat like pthread_create failing).
int MvlSchedSpawnThread(struct Machine *m2);

// SysExit's __EMSCRIPTEN__ implementation calls this (after ClearChildTid
// and HaltMachine(m, kMachineExitTrap) have unwound back into this
// thread's driver loop) to mark it done and permanently remove it from the
// round-robin ring. Never returns to the caller — swaps away immediately.
_Noreturn void MvlSchedThreadExitAndYield(void);

// Real fork/vfork-backed background jobs (SCHEDULER-DESIGN.md, Phase 4):
// like MvlSchedSpawnThread, but the fiber's entry point is CALLER-supplied
// instead of hardcoded. Fork()'s __EMSCRIPTEN__ path (syscall.c) uses this
// because completing a fork child needs syscall.c-private bookkeeping
// (EmStashChildStatus/g_em_children) this module deliberately doesn't know
// about — unlike a spawned thread, which is reaped via ctid/futex, a
// fork-style child is reaped via wait4(). `entry` receives `m2` directly
// (NOT the internal MvlThread wrapper other fibers are launched with — this
// module handles that unwrap internally) and must eventually call
// MvlSchedThreadExitAndYield() itself once done (same contract the
// hardcoded thread entry point follows internally).
//
// `fds_list` is the child's OWN independent fd list (a `struct Dll *`,
// blink/fds.h's `struct Fds.list` — build it via a duplication helper in
// syscall.c, e.g. walking the parent's fds and dup()ing each one) — pass
// NULL to instead SHARE the caller's fds like a real thread does
// (CLONE_FILES semantics; MvlSchedSpawnThread always does this). A fork
// child gets its own list because `struct Fds` lives on `struct System`,
// not `struct Machine` — sharing the System for memory (the whole point of
// this scheduler) means sharing ONE `struct Fds` object too, unless this
// module transparently swaps its `.list` pointer in and out on every
// context switch, which is what a non-NULL `fds_list` here signs up for.
// Found empirically: without this, a parent doing its OWN fd operations
// (e.g. a shell reading its next script line) while a child runs
// concurrently corrupts the PARENT's fd view, not just the child's —
// this isn't an edge case, it's the common case for any real script.
int MvlSchedSpawnWithEntry(struct Machine *m2, void (*entry)(struct Machine *m),
                           struct Dll *fds_list);

// True iff a LIVE (not yet exited) scheduled thread or fork-child with
// this tid is currently in the ring. wpid<=0 (POSIX wait()'s WAIT_ANY)
// matches any live non-main member. Lets SysWait4 (syscall.c) distinguish
// "genuinely no such child" (fail with ECHILD immediately, as before) from
// "child exists but hasn't finished yet" (keep yielding) — without this, a
// wait4() on a bogus pid would spin forever instead of failing correctly.
bool MvlSchedHasLiveChild(int wpid);

// main() is re-invoked many times per module instance in the wasm build
// (see stubs.c's em_reset_getopt comment for the general pattern) — this
// module's globals must not survive between top-level commands. Called
// from em_reset_children() alongside its existing resets.
void MvlSchedReset(void);

#endif /* MVL_DISPATCH_H_ */

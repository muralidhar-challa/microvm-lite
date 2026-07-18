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

// main() is re-invoked many times per module instance in the wasm build
// (see stubs.c's em_reset_getopt comment for the general pattern) — this
// module's globals must not survive between top-level commands. Called
// from em_reset_children() alongside its existing resets.
void MvlSchedReset(void);

#endif /* MVL_DISPATCH_H_ */

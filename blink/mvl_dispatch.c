#include "mvl_dispatch.h"
#include "mvl_sched.h"

#include <signal.h>
#include <stdlib.h>

#include "blink/assert.h"

#define MVL_THREAD_STACK_SIZE (256 * 1024)
#define MVL_YIELD_PERIOD 4096

struct MvlThread {
  struct Machine *m;
  SchedCtx ctx;
  char *stack;  // host fiber stack (NOT the guest's own stack); malloc'd.
  bool done;
  struct MvlThread *next;  // circular ring; g_mvl_current is our position in it.
  void (*custom_entry)(struct Machine *);  // 0 => use MvlThreadEntry.
  bool independent_fds;  // Phase 4: has its own fds_list, not the shared one.
  bool own_system;       // real fork(): owns its System, so its fds live on
                         // that System already — nothing to swap. See
                         // REAL-FORK.md.
  struct Dll *fds_list;  // valid only when independent_fds — see mvl_dispatch.h.
};

bool g_mvl_sched_active;
static struct MvlThread *g_mvl_current;
static struct MvlThread g_mvl_main;  // the implicit foreground thread
static bool g_mvl_main_ready;
static int g_mvl_yield_counter;
// The fds list every non-independent fiber (main + real threads) shares —
// captured once, before any fork/spawn touches m->system->fds.list, so
// swapping an independent fork-child's list in and back out always has a
// stable value to restore for everyone else. See mvl_dispatch.h's
// MvlSchedSpawnWithEntry doc for why this exists at all.
static struct Dll *g_mvl_canonical_fds;

// Lazily captures the calling machine as the ring's first member the first
// time a thread is ever spawned in this command — no separate call needed
// from blink.c's bootstrap, keeping this module's footprint additive.
static void MvlSchedEnsureMain(void) {
  if (g_mvl_main_ready) return;
  g_mvl_main.m = g_machine;
  g_mvl_main.done = false;
  g_mvl_main.stack = 0;
  g_mvl_main.independent_fds = false;
  g_mvl_main.next = &g_mvl_main;
  SchedInitCurrentContext(&g_mvl_main.ctx);
  g_mvl_current = &g_mvl_main;
  g_mvl_main_ready = true;
  g_mvl_canonical_fds = g_machine->system->fds.list;
}

// Installs `t`'s fds view into the shared System's fds.list — either its
// own independent list, or the canonical one every non-independent fiber
// shares. Called both right before swapping INTO a fiber and right after
// resuming one (whoever ran meanwhile left fds.list pointing at THEIR
// view, same hazard as g_machine).
static void MvlSchedInstallFds(struct MvlThread *t) {
  // A real-fork child points at its OWN System, whose fds.list is already
  // the right one. Writing g_mvl_canonical_fds into it would hand it the
  // PARENT's table and undo the isolation entirely.
  if (t->own_system) return;
  t->m->system->fds.list = t->independent_fds ? t->fds_list : g_mvl_canonical_fds;
}

static void MvlThreadEntry(void *arg) {
  struct MvlThread *t = (struct MvlThread *)arg;
  int rc;
  g_machine = t->m;
  if (!(rc = sigsetjmp(t->m->onhalt, 1))) {
    t->m->canhalt = true;
    unassert(!pthread_sigmask(SIG_SETMASK, &t->m->spawn_sigmask, 0));
    // Runs "forever" — Actor() only returns via siglongjmp. Yields
    // periodically through MvlSchedMaybeYield (called from Actor()'s loop)
    // until HaltMachine(t->m, kMachineExitTrap) is called from THIS
    // thread's own SysExit (syscall.c's __EMSCRIPTEN__ branch), which
    // siglongjmps straight back here.
    Actor(t->m);
  }
  // A fatal signal (SIGSEGV etc, any trapno other than kMachineExitTrap)
  // also lands here — Phase 3's minimal scope treats it the same as a
  // clean exit (silently ends the fiber) rather than propagating it
  // properly. Acceptable gap for the current gate (a well-behaved counter
  // test, no crashes expected); worth revisiting before this carries real
  // guest workloads.
  (void)rc;
  MvlSchedThreadExitAndYield();
}

// SchedMakeContext's fiber entry always receives the MvlThread WRAPPER as
// its void* arg (set below), never the Machine* directly — MvlThreadEntry
// already knows this (it unwraps t->m itself). A custom entry (Fork()'s
// EmForkChildEntry) is written against the simpler (struct Machine *)
// contract documented in mvl_dispatch.h, so this trampoline does the same
// unwrap on its behalf before calling it — got this backwards once already
// (a caller-supplied entry cast `arg` straight to `struct Machine *`,
// which is actually `t`; t->m, the real Machine*, happens to sit at t's
// own offset 0, so the misread silently "succeeded" as a plausible-looking
// but wrong pointer instead of crashing immediately, which is what made it
// hard to spot).
static void MvlCustomEntryTrampoline(void *arg) {
  struct MvlThread *t = (struct MvlThread *)arg;
  t->custom_entry(t->m);
}

static int MvlSchedSpawnInternal(struct Machine *m2,
                                 void (*custom_entry)(struct Machine *),
                                 bool independent_fds, struct Dll *fds_list,
                                 bool own_system) {
  struct MvlThread *t;
  MvlSchedEnsureMain();
  if (!(t = (struct MvlThread *)malloc(sizeof(*t)))) return -1;
  if (!(t->stack = (char *)malloc(MVL_THREAD_STACK_SIZE))) {
    free(t);
    return -1;
  }
  t->m = m2;
  t->done = false;
  t->custom_entry = custom_entry;
  t->independent_fds = independent_fds;
  t->fds_list = fds_list;
  t->own_system = own_system;
  SchedMakeContext(&t->ctx,
                   custom_entry ? MvlCustomEntryTrampoline : MvlThreadEntry,
                   t->stack, MVL_THREAD_STACK_SIZE, &g_mvl_main.ctx, t);
  // Splice in right after whoever's currently running — a freshly spawned
  // thread is next in the round-robin, simple and fair enough for v1.
  t->next = g_mvl_current->next;
  g_mvl_current->next = t;
  g_mvl_sched_active = true;
  return 0;
}

int MvlSchedSpawnThread(struct Machine *m2) {
  return MvlSchedSpawnInternal(m2, 0, false, 0, false);
}

int MvlSchedSpawnWithEntry(struct Machine *m2, void (*entry)(struct Machine *m),
                           struct Dll *fds_list) {
  return MvlSchedSpawnInternal(m2, entry, true, fds_list, false);
}

// Real fork(): the child owns its System, so the scheduler must not touch
// its fd table at all (REAL-FORK.md).
int MvlSchedSpawnOwnSystem(struct Machine *m2,
                           void (*entry)(struct Machine *m)) {
  return MvlSchedSpawnInternal(m2, entry, false, 0, true);
}

bool MvlSchedHasLiveChild(int wpid) {
  struct MvlThread *t;
  if (!g_mvl_current) return false;
  t = g_mvl_current;
  do {
    if (t != &g_mvl_main && !t->done && (wpid <= 0 || t->m->tid == wpid)) {
      return true;
    }
    t = t->next;
  } while (t != g_mvl_current);
  return false;
}

// Shared by MvlSchedMaybeYield and MvlSchedYieldOnce: swap out to the next
// ring member and, on resume, restore g_machine — the hazard Phase 2 proved
// under lldb (whoever ran meanwhile leaves it pointing at THEIR Machine) —
// and the fds view (same hazard, different field: whoever ran meanwhile may
// have left m->system->fds.list pointing at THEIR independent list — see
// MvlSchedSpawnWithEntry's doc in mvl_dispatch.h for why fds need this at
// all).
//
// Restore whatever g_machine WAS at the moment of yield, not unconditionally
// `me->m`. Phase 4 found the difference the hard way: SysExecve's vfork-
// child branch (syscall.c) temporarily points g_machine at a SECOND, nested
// Machine (a throwaway System for the exec'd program) while it runs a
// nested RunMachineUntilExit — a real Actor() loop, so this yield hook
// fires inside it too. Resetting to `me->m` there clobbers the nested
// call's own g_machine expectation with the OUTER forked-child Machine,
// corrupting page-table lookups the instant the nested loop resumes
// (confirmed: two concurrently-scheduled forks, each mid-execve, corrupting
// each other this way — single-fork cases never exercise the nested case,
// which is why this passed every earlier, simpler gate).
static void MvlSchedSwapToNext(void) {
  struct MvlThread *me = g_mvl_current, *next = me->next;
  struct Machine *saved = g_machine;
  if (me->independent_fds && !me->own_system) {
    me->fds_list = me->m->system->fds.list;  // capture mutations
  }
  g_mvl_current = next;
  MvlSchedInstallFds(next);
  SchedSwap(&me->ctx, &next->ctx);
  g_machine = saved;
  g_mvl_current = me;
  MvlSchedInstallFds(me);
}

void MvlSchedMaybeYield(void) {
  if (++g_mvl_yield_counter < MVL_YIELD_PERIOD) return;
  g_mvl_yield_counter = 0;
  if (!g_mvl_current || g_mvl_current->next == g_mvl_current) return;  // alone
  MvlSchedSwapToNext();
}

void MvlSchedYieldOnce(void) {
  if (!g_mvl_current || g_mvl_current->next == g_mvl_current) return;  // alone
  MvlSchedSwapToNext();
}

_Noreturn void MvlSchedThreadExitAndYield(void) {
  struct MvlThread *me = g_mvl_current, *p;
  me->done = true;
  for (p = me->next; p->next != me; p = p->next) {
  }
  if (p == me) {
    // Only reachable if `me` was alone in the ring — can't happen: this
    // path only runs for spawned threads (SysExit's __EMSCRIPTEN__ branch)
    // and fork children (EmForkChildEntry, syscall.c), and spawning always
    // leaves the main thread in the ring too.
    abort();
  }
  p->next = me->next;
  g_mvl_current = p;
  g_mvl_sched_active = (p->next != p);
  MvlSchedInstallFds(p);
  SchedSwap(&me->ctx, &p->ctx);
  // Never resumed: `me` is unlinked, nothing will swap to it again. Actual
  // memory cleanup (freeing t->m/t->stack) is deferred to Phase 6 (kill/
  // reap), matching the design doc's phasing — leaked here, not corrupted.
  for (;;) {
  }
}

void MvlSchedReset(void) {
  g_mvl_sched_active = false;
  g_mvl_current = 0;
  g_mvl_main_ready = false;
  g_mvl_yield_counter = 0;
}

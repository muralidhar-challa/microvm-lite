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
};

bool g_mvl_sched_active;
static struct MvlThread *g_mvl_current;
static struct MvlThread g_mvl_main;  // the implicit foreground thread
static bool g_mvl_main_ready;
static int g_mvl_yield_counter;

// Lazily captures the calling machine as the ring's first member the first
// time a thread is ever spawned in this command — no separate call needed
// from blink.c's bootstrap, keeping this module's footprint additive.
static void MvlSchedEnsureMain(void) {
  if (g_mvl_main_ready) return;
  g_mvl_main.m = g_machine;
  g_mvl_main.done = false;
  g_mvl_main.stack = 0;
  g_mvl_main.next = &g_mvl_main;
  SchedInitCurrentContext(&g_mvl_main.ctx);
  g_mvl_current = &g_mvl_main;
  g_mvl_main_ready = true;
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

int MvlSchedSpawnThread(struct Machine *m2) {
  struct MvlThread *t;
  MvlSchedEnsureMain();
  if (!(t = (struct MvlThread *)malloc(sizeof(*t)))) return -1;
  if (!(t->stack = (char *)malloc(MVL_THREAD_STACK_SIZE))) {
    free(t);
    return -1;
  }
  t->m = m2;
  t->done = false;
  SchedMakeContext(&t->ctx, MvlThreadEntry, t->stack, MVL_THREAD_STACK_SIZE,
                   &g_mvl_main.ctx, t);
  // Splice in right after whoever's currently running — a freshly spawned
  // thread is next in the round-robin, simple and fair enough for v1.
  t->next = g_mvl_current->next;
  g_mvl_current->next = t;
  g_mvl_sched_active = true;
  return 0;
}

// Shared by MvlSchedMaybeYield and MvlSchedYieldOnce: swap out to the next
// ring member and, on resume, reset g_machine — the hazard Phase 2 proved
// under lldb (whoever ran meanwhile leaves it pointing at THEIR Machine).
static void MvlSchedSwapToNext(void) {
  struct MvlThread *me = g_mvl_current, *next = me->next;
  g_mvl_current = next;
  SchedSwap(&me->ctx, &next->ctx);
  g_machine = me->m;
  g_mvl_current = me;
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
    // path only runs for SPAWNED threads (SysExit's __EMSCRIPTEN__ branch
    // is only taken when m->threaded), and spawning always leaves the
    // main thread in the ring too.
    abort();
  }
  p->next = me->next;
  g_mvl_current = p;
  g_mvl_sched_active = (p->next != p);
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

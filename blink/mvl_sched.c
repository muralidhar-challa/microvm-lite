#include "mvl_sched.h"

#include <stdio.h>
#include <string.h>

#if defined(MVL_NATIVE_DEBUG)

// makecontext's varargs are int-sized; passing a pointer through them isn't
// portable (breaks on LP64 where sizeof(void*) > sizeof(int)). Instead, each
// SchedCtx carries its OWN entry/arg (set at SchedMakeContext time, so
// creating context B can't clobber context A's pending entry/arg the way a
// single shared "pending" global would). SchedSwap records which ctx it's
// swapping into; SchedTrampoline — only ever invoked by ucontext on that
// context's first activation, never on a resume — reads it from there.
static SchedCtx *g_sched_launching;

static void SchedTrampoline(void) {
  SchedCtx *ctx = g_sched_launching;
  ctx->entry(ctx->arg);
}

void SchedInitCurrentContext(SchedCtx *ctx) {
  getcontext(&ctx->uc);  // Harmless here; swapcontext populates `from` too.
}

void SchedMakeContext(SchedCtx *ctx, void (*entry)(void *arg), char *stack,
                      size_t stacksize, SchedCtx *link, void *arg) {
  getcontext(&ctx->uc);
  ctx->uc.uc_stack.ss_sp = stack;
  ctx->uc.uc_stack.ss_size = stacksize;
  ctx->uc.uc_link = link ? &link->uc : 0;
  ctx->entry = entry;
  ctx->arg = arg;
  makecontext(&ctx->uc, SchedTrampoline, 0);
}

void SchedSwap(SchedCtx *from, SchedCtx *to) {
  g_sched_launching = to;
  swapcontext(&from->uc, &to->uc);
}

#elif defined(__EMSCRIPTEN__)

void SchedInitCurrentContext(SchedCtx *ctx) {
  emscripten_fiber_init_from_current_context(&ctx->fiber, ctx->asyncify_stack,
                                             sizeof(ctx->asyncify_stack));
}

void SchedMakeContext(SchedCtx *ctx, void (*entry)(void *arg), char *stack,
                      size_t stacksize, SchedCtx *link, void *arg) {
  (void)link;  // Fibers have no uc_link equivalent; entry must not return.
  emscripten_fiber_init(&ctx->fiber, entry, arg, stack, stacksize,
                        ctx->asyncify_stack, sizeof(ctx->asyncify_stack));
}

void SchedSwap(SchedCtx *from, SchedCtx *to) {
  emscripten_fiber_swap(&from->fiber, &to->fiber);
}

#endif

// ---- Phase 0 selftest ------------------------------------------------
//
// Two contexts (A, B) ping-pong: each swap increments ONE SHARED global
// counter and appends who ran to a shared log, until the log fills, then
// whichever is running swaps back to the caller instead of to its peer.
// A single SchedSwap(&g_st_main, &g_st_a) drives the whole thing — A and B
// never talk to g_st_main directly except on the very last swap.

#define SCHED_SELFTEST_SWAPS 20
#define SCHED_SELFTEST_STACK 65536

static SchedCtx g_st_main, g_st_a, g_st_b;
static char g_st_stack_a[SCHED_SELFTEST_STACK];
static char g_st_stack_b[SCHED_SELFTEST_STACK];
static int g_st_counter;  // SHARED, not per-context — the whole point.
// +1: never written by the swap loop (it stops at SCHED_SELFTEST_SWAPS
// bytes), stays 0 from the memset() below — a free NUL terminator so JS can
// read this straight as a C string (see em_fiber_selftest_log, Phase 1).
static char g_st_log[SCHED_SELFTEST_SWAPS + 1];
static int g_st_logn;

static void SchedSelftestBody(char who) {
  SchedCtx *self = (who == 'A') ? &g_st_a : &g_st_b;
  SchedCtx *peer = (who == 'A') ? &g_st_b : &g_st_a;
  for (;;) {
    g_st_log[g_st_logn++] = who;
    g_st_counter++;
    if (g_st_logn >= SCHED_SELFTEST_SWAPS) {
      SchedSwap(self, &g_st_main);
    } else {
      SchedSwap(self, peer);
    }
  }
}

static void SchedSelftestA(void *arg) { (void)arg; SchedSelftestBody('A'); }
static void SchedSelftestB(void *arg) { (void)arg; SchedSelftestBody('B'); }

int SchedSelftest(void) {
  int i, fail = 0;
  g_st_counter = 0;
  g_st_logn = 0;
  memset(g_st_log, 0, sizeof(g_st_log));

  SchedInitCurrentContext(&g_st_main);
  SchedMakeContext(&g_st_a, SchedSelftestA, g_st_stack_a, sizeof(g_st_stack_a),
                   &g_st_main, 0);
  SchedMakeContext(&g_st_b, SchedSelftestB, g_st_stack_b, sizeof(g_st_stack_b),
                   &g_st_main, 0);

  SchedSwap(&g_st_main, &g_st_a);

  if (g_st_counter != SCHED_SELFTEST_SWAPS) {
    fprintf(stderr, "SchedSelftest: counter=%d want=%d\n", g_st_counter,
            SCHED_SELFTEST_SWAPS);
    fail = 1;
  }
  if (g_st_logn != SCHED_SELFTEST_SWAPS) {
    fprintf(stderr, "SchedSelftest: logn=%d want=%d\n", g_st_logn,
            SCHED_SELFTEST_SWAPS);
    fail = 1;
  }
  for (i = 0; i < g_st_logn; i++) {
    char want = (i % 2 == 0) ? 'A' : 'B';
    if (g_st_log[i] != want) {
      fprintf(stderr, "SchedSelftest: log[%d]=%c want=%c (not alternating)\n",
              i, g_st_log[i], want);
      fail = 1;
    }
  }
  if (!fail) {
    fprintf(stderr, "SchedSelftest: OK (%d swaps, counter=%d, alternating A/B)\n",
            g_st_logn, g_st_counter);
  }
  return fail;
}

// Phase 1 (SCHEDULER-DESIGN.md): exported to JS so a playwright test can run
// this SAME ping-pong through whichever backend this build was compiled
// with. In the real wasm build (MVL_NATIVE_DEBUG undefined) that's the
// __EMSCRIPTEN__ branch above — this IS the validation that
// emscripten_fiber_init/emscripten_fiber_swap actually work under this
// project's exact emcc flags and worker environment, the open question
// Phase 1 exists to answer. Listed directly in build.sh's
// EXPORTED_FUNCTIONS (same convention as stubs.c's em_main/em_last_exit).
int em_fiber_selftest(void) {
  return SchedSelftest();
}

const char *em_fiber_selftest_log(void) {
  return g_st_log;
}

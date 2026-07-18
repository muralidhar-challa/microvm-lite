#include "mvl_sched.h"

#include <stdio.h>
#include <string.h>

#if defined(MVL_NATIVE_DEBUG)

void SchedMakeContext(SchedCtx *ctx, void (*entry)(void), char *stack,
                      size_t stacksize, SchedCtx *link) {
  getcontext(&ctx->uc);
  ctx->uc.uc_stack.ss_sp = stack;
  ctx->uc.uc_stack.ss_size = stacksize;
  ctx->uc.uc_link = link ? &link->uc : 0;
  makecontext(&ctx->uc, entry, 0);
}

void SchedSwap(SchedCtx *from, SchedCtx *to) {
  swapcontext(&from->uc, &to->uc);
}

#elif defined(__EMSCRIPTEN__)

void SchedMakeContext(SchedCtx *ctx, void (*entry)(void), char *stack,
                      size_t stacksize, SchedCtx *link) {
  (void)link;  // Fibers have no uc_link equivalent; entry must not return.
  emscripten_fiber_init(&ctx->fiber, (em_arg_callback_func)entry, 0, stack,
                        stacksize, ctx->asyncify_stack,
                        sizeof(ctx->asyncify_stack));
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
static char g_st_log[SCHED_SELFTEST_SWAPS];
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

static void SchedSelftestA(void) { SchedSelftestBody('A'); }
static void SchedSelftestB(void) { SchedSelftestBody('B'); }

int SchedSelftest(void) {
  int i, fail = 0;
  g_st_counter = 0;
  g_st_logn = 0;
  memset(g_st_log, 0, sizeof(g_st_log));

  SchedMakeContext(&g_st_a, SchedSelftestA, g_st_stack_a, sizeof(g_st_stack_a),
                   &g_st_main);
  SchedMakeContext(&g_st_b, SchedSelftestB, g_st_stack_b, sizeof(g_st_stack_b),
                   &g_st_main);

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

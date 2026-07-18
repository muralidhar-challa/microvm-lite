#ifndef MVL_SCHED_H_
#define MVL_SCHED_H_
#include <stddef.h>

// One cooperative execution context (its own C stack, its own instruction
// pointer), backed by ucontext (MVL_NATIVE_DEBUG, native lldb debugging) or
// Emscripten Fibers (__EMSCRIPTEN__, the real wasm build — Fibers are
// layered on top of Asyncify and need no build flag beyond the existing
// -sASYNCIFY). The native debug harness forces __EMSCRIPTEN__ *too* (to
// exercise blink's own wasm-only code paths under lldb), so MVL_NATIVE_DEBUG
// is checked first and wins — there is no real fiber.h to link against
// natively.
#if defined(MVL_NATIVE_DEBUG)

#include <ucontext.h>
typedef struct SchedCtx {
  ucontext_t uc;
} SchedCtx;

#elif defined(__EMSCRIPTEN__)

#include <emscripten/fiber.h>
typedef struct SchedCtx {
  emscripten_fiber_t fiber;
  char asyncify_stack[4096];
} SchedCtx;

#else
#error "mvl_sched.h needs either MVL_NATIVE_DEBUG or __EMSCRIPTEN__"
#endif

// Sets up `ctx` to start executing `entry()` (no args — callers needing to
// pass data do so via their own globals/closures over `entry`, same as
// SchedSelftest below) on `stack`/`stacksize` the first time something
// SchedSwap()s to it. `link` is the context resumed if entry() ever returns
// normally (ucontext semantics; the Emscripten backend ignores it — Fibers
// have no return-to-caller-on-return behavior, entry must swap out
// explicitly before returning).
void SchedMakeContext(SchedCtx *ctx, void (*entry)(void), char *stack,
                      size_t stacksize, SchedCtx *link);

// Suspends the CALLING context's state into `from` (so a later
// SchedSwap(x, from) resumes exactly here) and transfers control to `to`.
void SchedSwap(SchedCtx *from, SchedCtx *to);

// Phase 0 gate (see SCHEDULER-DESIGN.md): two contexts ping-pong, each
// incrementing ONE SHARED (not per-context) global counter and appending
// which context ran to a shared log — proving both contexts genuinely run,
// share memory (not divergent copies), and alternate (not one running to
// completion before the other starts). Returns 0 on success, nonzero on
// failure (diagnostic on stderr).
int SchedSelftest(void);

#endif /* MVL_SCHED_H_ */

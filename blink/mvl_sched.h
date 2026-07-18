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
  void (*entry)(void *arg);  // set by SchedMakeContext, read by the
  void *arg;                 // trampoline on this context's first run only.
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

// Marks `ctx` as representing the CALLING context itself, so a later
// SchedSwap(x, ctx) has a valid target to rewind into. Required before any
// context can be swapped BACK to if it was never set up via SchedMakeContext
// (e.g. the "main"/scheduler context a fiber swaps out to) — the Emscripten
// Fibers backend distinguishes "fresh entry point" from "resume" by a field
// that is only populated correctly by emscripten_fiber_init_from_current_
// context(); a zeroed/never-initialized fiber struct has stack_base=
// stack_max=0, and swapping into it sets the wasm stack limits to [0,0],
// trapping on the very next stack operation. ucontext doesn't have this
// requirement (swapcontext populates `from` unconditionally), but call this
// on every context that isn't created via SchedMakeContext regardless, for
// backend parity.
void SchedInitCurrentContext(SchedCtx *ctx);

// Sets up `ctx` to start executing `entry(arg)` on `stack`/`stacksize` the
// first time something SchedSwap()s to it. `link` is the context resumed if
// entry() ever returns normally (ucontext semantics; the Emscripten backend
// ignores it — Fibers have no return-to-caller-on-return behavior, entry
// must swap out explicitly before returning).
//
// `entry` must have EXACTLY this signature — void(void*) — even if it
// ignores `arg`. Emscripten Fibers call it through the wasm function table
// via a typed dynCall (dynCall_vi); a function whose real wasm type is
// void(void) (no params), even if its C pointer is cast to void(*)(void*),
// traps with "function signature mismatch" — casting a function pointer in
// C does not change the underlying wasm function type.
void SchedMakeContext(SchedCtx *ctx, void (*entry)(void *arg), char *stack,
                      size_t stacksize, SchedCtx *link, void *arg);

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

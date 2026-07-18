/* Native-debug stand-in for Emscripten's <emscripten.h>. Only covers what
 * blink-src's wasm-only (__EMSCRIPTEN__) code paths need to compile and link
 * as a NATIVE binary under -D__EMSCRIPTEN__ -DMVL_NATIVE_DEBUG, so the real
 * blink C code can be stepped through in lldb instead of the wasm interpreter.
 * Never used by the real wasm build (emcc supplies the genuine header then).
 *
 * EM_JS/EM_ASYNC_JS bodies are JS source text, not C — they are captured as
 * an opaque variadic macro argument and discarded; the expansion is just a
 * stub function returning a zero-ish value of the declared return type
 * (legal for void too: C allows `return expr;` in a void function when expr
 * itself has type void).
 */
#ifndef MVL_NATIVE_DEBUG_EMSCRIPTEN_SHIM_H_
#define MVL_NATIVE_DEBUG_EMSCRIPTEN_SHIM_H_

#include <time.h>

#define EM_JS(ret, name, params, ...) ret name params { return (ret)0; }
#define EM_ASYNC_JS(ret, name, params, ...) ret name params { return (ret)0; }
#define EM_ASM(...) do { } while (0)
#define EM_ASM_INT(...) 0

static inline void emscripten_sleep(unsigned int ms) {
  struct timespec ts;
  ts.tv_sec = (time_t)(ms / 1000u);
  ts.tv_nsec = (long)(ms % 1000u) * 1000000L;
  nanosleep(&ts, 0);
}

#endif /* MVL_NATIVE_DEBUG_EMSCRIPTEN_SHIM_H_ */

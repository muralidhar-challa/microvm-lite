// Phase 2 gate (SCHEDULER-DESIGN.md): two Machines sharing one System via
// NewMachine(system, parent) — mirroring SysSpawn directly, no guest ELF/
// shell involved — each writes a byte to a SHARED guest memory page across
// a fiber swap, and a third read (after both finish) sees BOTH writes.
// Also exercises the g_machine _Thread_local reassignment hazard: each body
// must reset g_machine to its OWN Machine right after resuming from a swap,
// since the peer's body will have overwritten it while it ran.
//
// Compiled into BOTH the native MVL_NATIVE_DEBUG harness (via
// blink/native-debug/phase2-main.c's main(), for lldb) and the real wasm
// build (exported as em_sched_phase2_test(), for a live-browser playwright
// check against the actual Emscripten Fiber backend) — same logic, same
// bugs either backend would hit, one source of truth.
#include <stdio.h>

#include "blink/machine.h"
#include "blink/x86.h"
#include "mvl_sched.h"

static struct System *g_p2_sys;
static struct Machine *g_p2_m1, *g_p2_m2;
static i64 g_p2_shared_addr;
static SchedCtx g_p2_main_ctx, g_p2_ctx1, g_p2_ctx2;
static char g_p2_stack1[65536], g_p2_stack2[65536];
static int g_p2_fail;

static void Phase2Body1(void *arg) {
  u8 val = 0xAA, readback = 0;
  (void)arg;
  g_machine = g_p2_m1;
  if (CopyToUser(g_p2_m1, g_p2_shared_addr, &val, 1) == -1) {
    fprintf(stderr, "Phase2: m1 CopyToUser failed\n");
    g_p2_fail = 1;
  }
  SchedSwap(&g_p2_ctx1, &g_p2_ctx2);
  // Resumed: g_machine currently holds whatever Body2 left it as (m2) — THE
  // hazard. Must reset before touching m1's memory view again.
  g_machine = g_p2_m1;
  if (CopyFromUser(g_p2_m1, &readback, g_p2_shared_addr + 1, 1) == -1 ||
      readback != 0xBB) {
    fprintf(stderr, "Phase2: m1 did not see m2's write, got %#x\n", readback);
    g_p2_fail = 1;
  }
  SchedSwap(&g_p2_ctx1, &g_p2_main_ctx);
}

static void Phase2Body2(void *arg) {
  u8 val = 0xBB;
  (void)arg;
  g_machine = g_p2_m2;
  if (CopyToUser(g_p2_m2, g_p2_shared_addr + 1, &val, 1) == -1) {
    fprintf(stderr, "Phase2: m2 CopyToUser failed\n");
    g_p2_fail = 1;
  }
  SchedSwap(&g_p2_ctx2, &g_p2_ctx1);
}

int MvlSchedPhase2Test(void) {
  u8 b0 = 0, b1 = 0;
  g_p2_fail = 0;

  g_p2_sys = NewSystem(XED_MACHINE_MODE_LONG);
  if (!g_p2_sys) { fprintf(stderr, "Phase2: NewSystem failed\n"); return 1; }
  // Normally done by loader.c as part of ELF-load bootstrap (loader.c:782);
  // we're skipping the ELF loader entirely, so it's on us to allocate the
  // root page table before the first ReserveVirtual call needs one.
  if ((g_p2_sys->cr3 = AllocatePageTable(g_p2_sys)) == (u64)-1) {
    fprintf(stderr, "Phase2: AllocatePageTable failed\n");
    return 1;
  }

  g_p2_m1 = NewMachine(g_p2_sys, 0);
  g_machine = g_p2_m1;
  if (!g_p2_m1) { fprintf(stderr, "Phase2: NewMachine(m1) failed\n"); return 1; }

  g_p2_m2 = NewMachine(g_p2_sys, g_p2_m1);  // shares system, clones m1's regs.
  if (!g_p2_m2) { fprintf(stderr, "Phase2: NewMachine(m2) failed\n"); return 1; }
  if (g_p2_m2->system != g_p2_m1->system) {
    fprintf(stderr, "Phase2: m2->system != m1->system (not sharing!)\n");
    g_p2_fail = 1;
  }

  g_p2_shared_addr =
      ReserveVirtual(g_p2_sys, 0, 4096, PAGE_U | PAGE_RW, -1, 0, 0, 0);
  if (g_p2_shared_addr == -1) {
    fprintf(stderr, "Phase2: ReserveVirtual failed\n");
    return 1;
  }

  SchedInitCurrentContext(&g_p2_main_ctx);
  SchedMakeContext(&g_p2_ctx1, Phase2Body1, g_p2_stack1, sizeof(g_p2_stack1),
                   &g_p2_main_ctx, 0);
  SchedMakeContext(&g_p2_ctx2, Phase2Body2, g_p2_stack2, sizeof(g_p2_stack2),
                   &g_p2_main_ctx, 0);

  SchedSwap(&g_p2_main_ctx, &g_p2_ctx1);

  // Third read, from the ORIGINAL (never-fibered) context — proves shared
  // visibility outlives the fiber bodies that produced it, not just that
  // they could see each other mid-flight.
  g_machine = g_p2_m1;
  CopyFromUser(g_p2_m1, &b0, g_p2_shared_addr, 1);
  CopyFromUser(g_p2_m1, &b1, g_p2_shared_addr + 1, 1);
  if (b0 != 0xAA || b1 != 0xBB) {
    fprintf(stderr, "Phase2: final check failed: b0=%#x b1=%#x\n", b0, b1);
    g_p2_fail = 1;
  }

  if (!g_p2_fail) {
    fprintf(stderr, "Phase2: OK (shared System, shared memory, g_machine "
                    "correctly reassigned across 3 swaps)\n");
  }
  return g_p2_fail;
}

// Exported to JS (build.sh's EXPORTED_FUNCTIONS) so a playwright test can
// run this against the REAL wasm build + real Emscripten Fibers, not just
// the native ucontext stand-in — Phase 1 found bugs that only showed up
// under the actual wasm/Asyncify backend, so this subsystem gets the same
// dual verification.
int em_sched_phase2_test(void) {
  return MvlSchedPhase2Test();
}

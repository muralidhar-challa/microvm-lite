// Phase 2 gate driver (native lldb harness). The actual test logic lives in
// blink/mvl_sched_phase2_test.c (MvlSchedPhase2Test), shared with the wasm
// build's em_sched_phase2_test() export — see SCHEDULER-DESIGN.md, Phase 2.
// Not part of the shipped wasm build.
#include <stdio.h>

int MvlSchedPhase2Test(void);

int main(void) {
  int rc = MvlSchedPhase2Test();
  printf(rc == 0 ? "PASS\n" : "FAIL\n");
  return rc;
}

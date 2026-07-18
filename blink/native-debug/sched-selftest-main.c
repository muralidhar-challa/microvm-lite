// Phase 0 gate driver: exercises SchedSelftest() in isolation (no blink
// headers needed — mvl_sched.c is self-contained). Not part of the shipped
// build; compiled only by test/native-sched-selftest.sh.
#include <stdio.h>
#include "../mvl_sched.h"

int main(void) {
  int rc = SchedSelftest();
  printf(rc == 0 ? "PASS\n" : "FAIL\n");
  return rc;
}

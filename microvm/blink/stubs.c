#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include "blink/machine.h"
#include "blink/linux.h"
#include "blink/types.h"

// NOTE: a Sys* stub's negative return value goes to the guest RAW (only -1
// triggers the host-errno translation), so it must use *_LINUX errno numbers.
// Returning -ENOSYS here used Emscripten's WASI numbering (ENOSYS=52) and the
// guest saw the meaningless errno 52.
int SysIoctl(struct Machine *m, int fd, u64 request, i64 addr) {
  (void)m; (void)addr;
  switch (request) {
    case FIONBIO_LINUX:
      // Rust std's set_nonblocking() — used inside TcpStream::connect_timeout,
      // i.e. by every ureq client (runner/app). Nothing in this build actually
      // blocks (virtual sockets answer from a buffer, MEMFS files are
      // synchronous), so accepting the flag without applying it is faithful.
      return 0;
    case FIOCLEX_LINUX:
      fcntl(fd, F_SETFD, FD_CLOEXEC);
      return 0;
    case FIONCLEX_LINUX:
      fcntl(fd, F_SETFD, 0);
      return 0;
    default:
      // What a real kernel says for an unsupported ioctl on a non-tty.
      return -ENOTTY_LINUX;
  }
}

int SysStatfs(struct Machine *m, i64 path, i64 buf) {
  (void)m; (void)path; (void)buf;
  return -ENOSYS_LINUX;
}

int SysFstatfs(struct Machine *m, i32 fd, i64 buf) {
  (void)m; (void)fd; (void)buf;
  return -ENOSYS_LINUX;
}

int SendAncillary(struct Machine *m, struct msghdr *msg,
                  const struct msghdr_linux *guestmsg) {
  (void)m; (void)msg; (void)guestmsg;
  return -ENOSYS_LINUX;
}

int ReceiveAncillary(struct Machine *m, struct msghdr_linux *guestmsg,
                     struct msghdr *msg, int flags) {
  (void)m; (void)guestmsg; (void)msg; (void)flags;
  return -ENOSYS_LINUX;
}

int GetCpuCount(void) {
  return 1;
}

int mkfifoat_(int dirfd, const char *path, mode_t mode) {
  (void)dirfd; (void)path; (void)mode;
  errno = ENOSYS;
  return -1;
}

// blink's vendored getopt keeps parse state in globals; main() is re-invoked
// many times per module instance in the wasm build, so the host resets this
// before each call. (getopt_place is file-static but always ends on a '\0'
// after a completed parse, and the host keeps the previous argv allocated
// until the next call, so the stale pointer is never read as a live flag.)
extern int optind_;
extern char *optarg_;
void em_reset_getopt(void) {
  optind_ = 0;
  optarg_ = 0;
}

// Asyncify loses the return value of a main() that suspended mid-run, so the
// host calls em_main() instead and reads the guest's exit code back through
// em_last_exit() after the promise resolves.
static int em_exit_code;
extern int main(int argc, char *argv[]);
int em_main(int argc, char *argv[]) {
  em_exit_code = main(argc, argv);
  return em_exit_code;
}
int em_last_exit(void) {
  return em_exit_code;
}

int sysinfo_linux(struct sysinfo_linux *info) {
  (void)info;
  return -ENOSYS_LINUX;
}

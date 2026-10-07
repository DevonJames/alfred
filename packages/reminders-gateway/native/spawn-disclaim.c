#include <spawn.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>

extern char **environ;
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attr, unsigned int disclaim);

/* macOS attributes Reminders privacy to the parent of a directly executed helper.
   Disclaiming that parent makes Alfred Reminders its own client, which is the
   app the user allowed. */
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  if (responsibility_spawnattrs_setdisclaim(&attr, 1) != 0) return 1;
  pid_t pid = 0;
  int rc = posix_spawn(&pid, argv[1], NULL, &attr, argv + 1, environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) return 1;
  int status = 0;
  if (waitpid(pid, &status, 0) < 0) return 1;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 1;
}

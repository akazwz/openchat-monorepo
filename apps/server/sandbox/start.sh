#!/bin/bash
# Native container entrypoint: prepare shared memory, then stay alive.
# tini remains PID 1 and reaps orphaned desktop and command processes.
set -uo pipefail

# Cloudflare's containers start without /dev/shm, which a Linux machine has
# and programs expect for POSIX shared memory (Python's multiprocessing among
# them). A directory under /dev, itself in memory, serves. Made here, before
# native commands start; the screen now
# starts after the workspace is restored, alongside the first commands.
if [ ! -d /dev/shm ]; then
  mkdir -p /dev/shm && chmod 1777 /dev/shm || echo "No /dev/shm" >&2
fi

exec sleep infinity

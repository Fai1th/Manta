#!/bin/sh
set -eu
# Railway mounts volumes as root; initialize the directory before dropping privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown node:node "${DATA_DIR:-/data}"
  exec su node -s /bin/sh -c 'exec node src/server.js'
fi
exec node src/server.js

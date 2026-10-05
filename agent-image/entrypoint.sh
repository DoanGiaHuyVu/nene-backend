#!/bin/sh
set -eu

# Keep all writable storage inside the disposable workspace volume.
export HOME=/workspace/.nene-agent
export TMPDIR=/workspace/.tmp
export TMP="$TMPDIR"
export TEMP="$TMPDIR"

mkdir -p "$HOME/.backboard" "$TMPDIR"

if [ -r /seed/backboard-config.json ]; then
    cp /seed/backboard-config.json \
       "$HOME/.backboard/config.json"
fi

exec /usr/local/bin/backboard "$@"

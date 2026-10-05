#!/bin/sh
set -eu

# Always use writable temporary storage for Backboard's home.
# The rest of the container filesystem will be read-only.
export HOME=/tmp/nene-agent

mkdir -p "$HOME/.backboard"

if [ -r /seed/backboard-config.json ]; then
    cp /seed/backboard-config.json \
       "$HOME/.backboard/config.json"
fi

exec /usr/local/bin/backboard "$@"

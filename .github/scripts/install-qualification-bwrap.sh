#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_ACTIONS:-}" = true
test "$(uname -s)" = Linux
source_root=$(mktemp -d "${RUNNER_TEMP:?}/qualification-bwrap.XXXXXX")
trap 'rm -rf -- "$source_root"' EXIT

# Match the VPS mount checks; Ubuntu 24.04's backport accepts symlink targets.
curl --fail --location --proto '=https' --tlsv1.2 \
    https://github.com/containers/bubblewrap/releases/download/v0.11.1/bubblewrap-0.11.1.tar.xz \
    --output "$source_root/bubblewrap.tar.xz"
printf '%s  %s\n' \
    c1b7455a1283b1295879a46d5f001dfd088c0bb0f238abb5e128b3583a246f71 \
    "$source_root/bubblewrap.tar.xz" | sha256sum --check
tar -xJf "$source_root/bubblewrap.tar.xz" -C "$source_root"
meson setup "$source_root/build" "$source_root/bubblewrap-0.11.1" \
    --wrap-mode=nodownload --buildtype=release \
    -Dman=disabled -Dtests=false -Dselinux=disabled \
    -Dbash_completion=disabled -Dzsh_completion=disabled
meson compile -C "$source_root/build"
sudo install -m 0755 "$source_root/build/bwrap" /usr/local/bin/bwrap
test "$(command -v bwrap)" = /usr/local/bin/bwrap
test "$(bwrap --version)" = 'bubblewrap 0.11.1'
bwrap --version

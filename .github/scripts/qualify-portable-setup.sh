#!/usr/bin/env bash
# Disposable CI hosts only. The production operator never installs host tools.
set -euo pipefail
umask 022
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -m)" = x86_64
source_root=$(pwd -P)
runtime_input=$(realpath "$1")
qualification_root=$2
test ! -e "$qualification_root"
mkdir -p "$qualification_root/evidence"
exec > >(tee "$qualification_root/evidence/qualification.log") 2>&1
uname -a
if [[ "$QUALIFICATION_PLATFORM" == wsl2 ]]; then
  uname -r | grep -i microsoft-standard-WSL2
else
  ! uname -r | grep -qi microsoft
fi
sudo apt-get update
sudo apt-get install -y ca-certificates curl git unzip xz-utils python3 build-essential php-cli composer golang-go bubblewrap libcap2-bin gh
if test -e /proc/sys/kernel/unprivileged_userns_clone; then
  sudo sysctl -w kernel.unprivileged_userns_clone=1
fi
if test -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
if ! command -v node >/dev/null || [[ $(node --version) != v24.18.0 ]]; then
  curl --fail --location https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz -o "$qualification_root/node.tar.xz"
  echo "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742  $qualification_root/node.tar.xz" | sha256sum --check
  mkdir "$qualification_root/node"
  tar -xJf "$qualification_root/node.tar.xz" -C "$qualification_root/node" --strip-components=1
  export PATH="$qualification_root/node/bin:$PATH"
fi
# Bootstrap the firewall first, then retain it around every supported install.
export npm_config_min_release_age=7
export npm_config_ignore_scripts=true
export npm_config_allow_git=none
npm view sfw@2.0.6 version | grep -Fx 2.0.6
npm install --prefix "$qualification_root/host" --ignore-scripts --no-audit --no-fund sfw@2.0.6
export PATH="$qualification_root/host/node_modules/.bin:$PATH"
npm view corepack@0.34.6 version | grep -Fx 0.34.6
sfw npm install --prefix "$qualification_root/host" --ignore-scripts --no-audit --no-fund corepack@0.34.6
if ! command -v bun >/dev/null; then
  npm view bun@1.3.14 version | grep -Fx 1.3.14
  sfw npm install --prefix "$qualification_root/host" --ignore-scripts --no-audit --no-fund @oven/bun-linux-x64@1.3.14
  export PATH="$qualification_root/host/node_modules/@oven/bun-linux-x64/bin:$PATH"
fi
test "$(bun --version)" = 1.3.14
sfw --version
mkdir "$qualification_root/zerobox"
expected=$(cut -d ' ' -f1 "$runtime_input/qualified-native-runtime.sha256")
echo "$expected  $runtime_input/qualified-native-runtime.tgz" | sha256sum --check
tar -xzf "$runtime_input/qualified-native-runtime.tgz" -C "$qualification_root/zerobox"
export QUALIFICATION_SOURCE_SHA=${QUALIFICATION_SOURCE_SHA:-${GITHUB_SHA:?}}
# A normal short home also respects Zerobox's Linux AF_UNIX socket budget.
export QUALIFICATION_HOME=/home/pi-ci
test ! -e "$QUALIFICATION_HOME"
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$QUALIFICATION_HOME"
export QUALIFICATION_ROOT="$qualification_root"
export QUALIFICATION_ZEROBOX="$qualification_root/zerobox"
export HOME="$qualification_root/producer-home"
mkdir -p "$HOME"
cat > "$HOME/.bunfig.toml" <<'BUN_CONFIG'
[install]
minimumReleaseAge = 604800
BUN_CONFIG
export PI_CODING_AGENT_DIR="$source_root/agent"
export PI_OFFLINE=1
export PI_PACKAGE_FINALIZER_ACTIVE=1
bun bin/pi-fork import .github/fixtures/pi-core-1.1.0
bun .github/scripts/qualify-portable-setup.ts "$source_root"

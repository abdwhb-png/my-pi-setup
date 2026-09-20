#!/usr/bin/env bash
# Run the explicit, source-built Zerobox candidate contracts. This command never
# falls back to a managed or host-installed Zerobox executable.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
agent_root=$(cd -- "${script_dir}/.." && pwd -P)

fail() {
    printf '%s\n' "zerobox candidate contracts: $*" >&2
    exit 2
}

require_env() {
    local name=$1
    [[ -n ${!name:-} ]] || fail "${name} is required"
}

require_absolute_path() {
    local name=$1
    [[ ${!name} == /* ]] || fail "${name} must be an absolute path"
}

validate_candidate() {
    [[ $(uname -s) == Linux ]] || fail "Linux is required"

    require_env PI_SANDBOX_RUNTIME_BUNDLE
    require_env PI_SANDBOX_ZEROBOX_BINARY
    require_env PI_SANDBOX_ZEROBOX_SHA256
    require_absolute_path PI_SANDBOX_RUNTIME_BUNDLE
    require_absolute_path PI_SANDBOX_ZEROBOX_BINARY

    [[ -d ${PI_SANDBOX_RUNTIME_BUNDLE} ]] || fail "PI_SANDBOX_RUNTIME_BUNDLE is not a directory"
    [[ -x ${PI_SANDBOX_ZEROBOX_BINARY} ]] || fail "PI_SANDBOX_ZEROBOX_BINARY is not executable"
    [[ -f ${PI_SANDBOX_RUNTIME_BUNDLE}/manifest.json ]] || fail "PI_SANDBOX_RUNTIME_BUNDLE is missing manifest.json"
    [[ -f ${PI_SANDBOX_RUNTIME_BUNDLE}/provenance.json ]] || fail "PI_SANDBOX_RUNTIME_BUNDLE is missing provenance.json"
    [[ ${PI_SANDBOX_ZEROBOX_SHA256} =~ ^[a-f0-9]{64}$ ]] || fail "PI_SANDBOX_ZEROBOX_SHA256 must be a lowercase SHA-256"

    local expected_binary actual_binary actual_sha
    expected_binary=$(realpath -e -- "${PI_SANDBOX_RUNTIME_BUNDLE}/bin/zerobox") || fail "candidate bundle is missing bin/zerobox"
    actual_binary=$(realpath -e -- "${PI_SANDBOX_ZEROBOX_BINARY}") || fail "cannot resolve PI_SANDBOX_ZEROBOX_BINARY"
    [[ ${actual_binary} == "${expected_binary}" ]] || fail "PI_SANDBOX_ZEROBOX_BINARY must be PI_SANDBOX_RUNTIME_BUNDLE/bin/zerobox"
    actual_sha=$(sha256sum -- "${actual_binary}" | awk '{print $1}')
    [[ ${actual_sha} == "${PI_SANDBOX_ZEROBOX_SHA256}" ]] || fail "PI_SANDBOX_ZEROBOX_SHA256 does not match PI_SANDBOX_ZEROBOX_BINARY"

    if [[ -n ${PI_SANDBOX_ZEROBOX_SOURCE_ROOT:-} ]]; then
        require_absolute_path PI_SANDBOX_ZEROBOX_SOURCE_ROOT
        [[ -d ${PI_SANDBOX_ZEROBOX_SOURCE_ROOT} ]] || fail "PI_SANDBOX_ZEROBOX_SOURCE_ROOT is not a directory"
        git -C "${PI_SANDBOX_ZEROBOX_SOURCE_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "PI_SANDBOX_ZEROBOX_SOURCE_ROOT is not a Git worktree"
        [[ -f ${PI_SANDBOX_ZEROBOX_SOURCE_ROOT}/scripts/sync.sh ]] || fail "PI_SANDBOX_ZEROBOX_SOURCE_ROOT is missing scripts/sync.sh"
    fi
}

usage() {
    cat <<'EOF'
Usage: bun run test:sandbox:zerobox-candidate [--validate]

Require PI_SANDBOX_RUNTIME_BUNDLE, PI_SANDBOX_ZEROBOX_BINARY and
PI_SANDBOX_ZEROBOX_SHA256 for a single private runtime candidate. Set
PI_SANDBOX_ZEROBOX_SOURCE_ROOT when the source worktree is available to enable
the candidate-source provenance contract.
EOF
}

case ${1:-} in
    "") ;;
    --validate) validate_only=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
esac

validate_candidate
if [[ ${validate_only:-0} == 1 ]]; then
    printf '%s\n' "Zerobox candidate contract configuration is valid"
    exit 0
fi

cd -- "${agent_root}"
export PI_SANDBOX_LOCAL_RESOURCES_CONTRACT=1
export PI_SANDBOX_LOCAL_NETWORK_CONTRACT=1
export PI_SANDBOX_REAL_SHELL_MODES_CONTRACT=1
export PI_SANDBOX_SHELL_BASELINE_CONTRACT=1
export PI_SANDBOX_INSTALLATIONS_CONTRACT=1
export PI_SANDBOX_GENERIC_COMMAND_CONTRACT=1
export PI_SANDBOX_REAL_ANALYSIS_CONTRACT=1
export PI_SANDBOX_REAL_ANALYSIS_IPC_CONTRACT=1

exec bun test --isolate \
    extensions/sandbox/execution.test.ts \
    extensions/sandbox/dependency-contract.test.ts \
    extensions/sandbox/local-resources.integration.test.ts \
    extensions/sandbox/native-authority.integration.test.ts \
    extensions/sandbox/real-shell-modes.integration.test.ts \
    extensions/sandbox/docker-access.integration.test.ts \
    extensions/sandbox/docker-exec.integration.test.ts \
    extensions/sandbox/docker-policy-config.integration.test.ts \
    extensions/sandbox/analysis/client.execPath.regression.test.ts \
    extensions/sandbox/analysis/client.integration.test.ts \
    extensions/sandbox/analysis/real-engine.integration.test.ts \
    extensions/sandbox/runtime/shell-baseline.integration.test.ts \
    extensions/sandbox/runtime/isolation-defaults.integration.test.ts \
    extensions/sandbox/runtime/installations.integration.test.ts \
    extensions/sandbox/runtime/revocation.integration.test.ts \
    extensions/sandbox/runtime/linux-contract.integration.test.ts \
    extensions/sandbox/runtime/generic-command.integration.test.ts \
    extensions/sandbox/runtime/profiles.integration.test.ts \
    extensions/sandbox/runtime/read-only-cwd.integration.test.ts \
    extensions/sandbox/runtime/websocket.integration.test.ts \
    extensions/sandbox/runtime/fork-contract.integration.test.ts \
    extensions/sandbox/runtime/safe-bash-fork-contract.integration.test.ts

/**
 * Pure guard logic for safe-bash.
 *
 * Re-exports from the shared helper under extensions/_shared/.
 * Kept as a thin wrapper so existing tests in guard.test.ts
 * continue to work without changes.
 */
export { isDangerous, redirectShellCommand, redirectShellCommandWithPolicy } from "../_shared/bash-guard";
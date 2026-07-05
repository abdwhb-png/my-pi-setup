/**
 * Visibility (hidden ids) helpers for pi-fancy-footer config.
 *
 * The visibility state lives in `~/.pi/agent/fancy-footer.json` under
 * `extensionStatusHiddenIds`. We keep these helpers pure + testable and let the
 * command module wire file IO through the standard fancy-footer config bridge.
 */

export function isHidden(
  hiddenIds: readonly string[],
  id: string,
): boolean {
  return hiddenIds.includes(id);
}

export function toggleHidden(
  hiddenIds: readonly string[],
  id: string,
): { hiddenIds: string[]; nowHidden: boolean } {
  const set = new Set(hiddenIds);
  let nowHidden: boolean;
  if (set.has(id)) {
    set.delete(id);
    nowHidden = false;
  } else {
    set.add(id);
    nowHidden = true;
  }
  return { hiddenIds: Array.from(set), nowHidden };
}

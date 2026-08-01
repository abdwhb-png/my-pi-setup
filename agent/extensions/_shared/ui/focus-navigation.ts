export type FocusDirection = -1 | 1;

export function cycleFocus<T>(
    order: readonly T[],
    current: T,
    direction: FocusDirection,
): T {
    if (order.length === 0) return current;

    const currentIndex = order.indexOf(current);
    if (currentIndex === -1) {
        return direction === 1 ? order[0] : order[order.length - 1];
    }

    const nextIndex = (currentIndex + direction + order.length) % order.length;
    return order[nextIndex];
}

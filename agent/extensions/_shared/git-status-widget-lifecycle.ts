export interface RefreshGate {
    begin(): number;
    invalidate(): void;
    isCurrent(refresh: number): boolean;
}

export function createRefreshGate(): RefreshGate {
    let generation = 0;

    return {
        begin() {
            generation += 1;
            return generation;
        },
        invalidate() {
            generation += 1;
        },
        isCurrent(refresh) {
            return refresh === generation;
        },
    };
}

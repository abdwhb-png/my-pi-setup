import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function assertSetupLaunchAllowed(
    root: string,
    transactionId = process.env.PI_SETUP_TRANSACTION_ID,
): void {
    const journal = `${resolve(root)}.setup-journal.json`;
    if (!existsSync(journal)) return;
    const value = JSON.parse(readFileSync(journal, 'utf8'));
    if (
        transactionId &&
        value.id === transactionId &&
        value.phase === 'activating'
    )
        return;
    throw new Error(
        'Pi setup transaction is active or interrupted. Wait for completion or run pi-setup recover.',
    );
}

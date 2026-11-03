import { resolve } from 'node:path';
import { finalizeDistribution } from '../../agent/bin/setup/distribution.ts';

const [sourceRoot, directory, evidenceDirectory] = process.argv.slice(2);
if (!sourceRoot || !directory || !evidenceDirectory)
    throw new Error('Expected source, candidate and evidence directories');
await finalizeDistribution({
    sourceRoot: resolve(sourceRoot),
    directory: resolve(directory),
    evidenceDirectory: resolve(evidenceDirectory),
});

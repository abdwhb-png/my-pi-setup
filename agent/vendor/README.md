# Local test harness artifact

`pi-test-harness-0.11.0.tgz` is the immutable development dependency qualified for the personal Pi 1.5.0 fork. It is not an npm publication.

- Canonical source: `~/engineering/pi-integrations/pi-test-harness`, local commit `72d03a60cb36c2a00d802d4759a9b6d7ba083fe3` (not pushed).
- SHA-256: `281a8967202b4ae70d218c1f89ead0518f26d5d3decaed518d2091eb3e46a355`.
- Required core baseline: the personal Pi 1.5.0 fork including startup-callback cleanup.
- Validation: lint, typecheck, unit/integration tests, Bun extension loading, and both installed artifact formats under Node 26 and Bun 1.4.3. The Node 22/24 and Windows CI matrix was not rerun.

This generated package crosses the independent repository boundary so a local setup checkout can install the unpublished version without a mutable source link or an unavailable registry version. Its license accompanies the archive as `pi-test-harness.LICENSE`. Do not edit the archive: update the canonical repository, build with `npm run build`, qualify both consumers with `npm run test:consumer` and `npm run test:consumer -- --runtime=bun`, then replace the archive and record its source commit and digest here.

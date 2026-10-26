# Think Execute diagnostics verification

## Change

Think's fixed execution and artifact-search interface text is English. Collapsed failures include their safe reason and recovery. User source text and derivations retain their language.

QuickJS errors carry an optional, closed `errorClass` through the sealed worker response, Analysis host, client, shared branded error contract, and Think failure JSON. The allowed classes are `SyntaxError`, `ReferenceError`, `TypeError`, `RangeError`, `EvalError`, `URIError`, `InternalError`, and `Error`. Public reasons are static; raw messages, stack traces, bindings, and arbitrary error names are not exposed. Older runtime responses and Python errors retain generic diagnostics. Existing failure codes, recovery values, execution provenance, and Pi `isError` behavior remain intact.

The tool schema and README document standalone calculations with `action:"content"`, `content:""`, and an ES module default export. No action, dependency, shell permission, or personal configuration was added.

## Local evidence

- The source worker, host, protocol, and English-rendering regressions failed before implementation for missing metadata and the old French text, then passed after correction. Coordinator and public-payload regressions separately reproduced the lost class and arbitrary-name exposure before correction.
- The focused suite covering Think, Analysis, and the shared Sandbox runtime ran 344 tests: 326 passed, 17 opt-in scenarios skipped, and one description-contract test failed. Restoring the existing bounded-derivation wording fixed that failure; the entire 21-test registered-Pi-runtime file then passed. This establishes 327 passing tests across the covered scenarios after the correction, not a second all-green execution of the whole suite.
- Tests exercise actual QuickJS errors for JavaScript and TypeScript, host/client response validation, separate Jiti caches, safe public error payloads, secret sentinels, absence of failed-analysis indexing, English rendering, empty input, and registered Pi `isError:true` behavior.
- `bun run lint` completed successfully, including extension ownership and storage checks. Existing warnings remain. `bun run typecheck` reports only the four pre-existing errors in `agent-browser-sandbox-artifacts.integration.test.ts`, `sandbox/preparation.test.ts`, and `sandbox/runtime/runtime-bundle.test.ts`; no task-file errors remain.
- The new sealed-worker contracts are opt-in and are included in the existing native candidate-contract runner. Source-only tests do not establish that the promoted worker contains this change.
- The sealed-worker regression was run against the unchanged daily runtime. Its first attempt hit the 20-second fixture deadline; after allowing the same 45-second setup envelope as the existing real-engine tests and keeping worker execution limited to 15 seconds, it failed for the intended reason: expected `SyntaxError`, received no metadata. This is negative deployment evidence, not qualification of the new worker.

## Delivery status

Native qualification and promotion are pending. The existing promoted runtime remains unchanged until the exact rebuilt artifact passes the native Linux workflow and installed-runtime verification. The Zerobox engine source revision and shell policies are unchanged.

## Separate limitation

The installed TypeScript transformer can emit JavaScript despite malformed TypeScript input: `export default 1 ≤ 2;` can resolve instead of raising a syntax error. This correction preserves error categories actually emitted by QuickJS; it does not add a TypeScript syntax-validation phase. TypeScript category coverage uses explicit engine `SyntaxError`, `ReferenceError`, and `TypeError` failures. Rejecting malformed TypeScript before transformation requires separate work.

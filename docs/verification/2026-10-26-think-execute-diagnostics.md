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

Completed: source commit `079b1577fe377a90d7632052777903a11014fffb` was pushed to `develop`, qualified by [native CI run 40321985864](https://github.com/abdwhb-png/my-pi-setup/actions/runs/40321985864), and its exact artifact was promoted as `native-40321985864-1`. The CI boundary suite passed 1,261 tests with 85 opt-in skips and zero failures; all 26 explicit candidate-contract files passed afterward, including the six new sealed-worker diagnostic cases. The final installed-runtime check also passed on the native runner.

The GitHub artifact is `12650360696` with ZIP SHA-256 `60a6bd5d78200685b9c8129118d4c420dfa7e752e6529f4d55b14acb6385da6a`; its tar archive SHA-256 is `38b69f002aa524ab8e17c0691a890f8de14c0ecaeb4865fa61eb13964a03a638`. Both were verified before extracting and sealing the artifact through the existing distribution builder. Runtime manifest SHA-256 is `d7fffe7d49ca60b0f5ed9f0de1a3a4fac9441e3e6271a5c36e2ca3471e089929`. The engine/helper bytes remain SHA-256 `1232884cc94810b051736ee7d5502a078f193758bd8e63571e201723feb8000c`, built from the unchanged engine source revision `a894c62407854f0e17d35a8250696f100b8f3ad2`.

Before promotion, a fresh real Pi session loaded the public Sandbox and Think entrypoints and used an isolated managed installation of that artifact. Five unmocked Think calls passed 23 assertions: JavaScript syntax failure, JavaScript reference failure, TypeScript type failure carrying a secret sentinel, corrected comparison, and standalone calculation. The first local fixture used a HOME path exceeding the existing Linux AF_UNIX socket budget and failed preflight; shortening only that temporary HOME resolved it. This was a fixture correction, not a relaxation of Sandbox policy. No LLM/provider call was made.

The daily managed entry now points to `../runtimes/zerobox/native-40321985864-1/bin/zerobox`. After promotion, the existing installed-runtime contract passed for `bash` and `safe_bash` with 14 assertions. Global `sandbox.json` and `settings.json` hashes stayed identical before and after activation. The previous `native-40305494210-1` release remains intact. Existing Pi sessions need `/reload` or a restart to load the updated extension code and schema.

Evidence, qualification metadata, and activation state are retained under `~/.cache/pi-think-diagnostics-20261026/`. The guarded rollback script is `rollback/rollback.py` under that directory; it restores only the previous managed link after checking the current link, engine hash, and manifest hash. Its syntax was checked; rollback was not executed. Unrelated local changes were excluded from the commits.

## Separate limitation

The installed TypeScript transformer can emit JavaScript despite malformed TypeScript input: `export default 1 ≤ 2;` can resolve instead of raising a syntax error. This correction preserves error categories actually emitted by QuickJS; it does not add a TypeScript syntax-validation phase. TypeScript category coverage uses explicit engine `SyntaxError`, `ReferenceError`, and `TypeError` failures. Rejecting malformed TypeScript before transformation requires separate work.

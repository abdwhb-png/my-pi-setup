# Private portability qualification in GitHub Actions

Real personal-profile, publication and provider verification runs on disposable GitHub-hosted runners, never against the daily installation. The public workflow uses synthetic data. The private workflow must live in `abdwhb-png/my-pi-distribution`; it refuses another repository or an actor other than the repository owner. There are no push, pull-request or scheduled triggers for private checks.

## Release contract

The [repository release skill](../.agents/skills/pi-setup-release/SKILL.md) owns the promotion and publication procedure. The distribution repository must be private with an initialized default branch. Keep its workflow byte-identical to this repository's canonical workflow. Published releases require immutability; qualification accepts only a private draft and never weakens the attestation requirement for client installations.

| Workflow input | Contract |
| --- | --- |
| `source_sha` | Full approved commit on `my-pi-setup` main. The package and qualification must identify this same source. |
| `candidate_release` | Existing private draft containing exactly `setup.tgz` and `release.json`, using the final release tag. |
| `candidate_sha256` | Expected SHA-256 of `setup.tgz`, recorded when preparing the package. |
| `publish` | False by default. True authorizes finalization of this same draft only after complete qualification succeeds. |
| `profile_only` | Optional shortened diagnosis; rejected when publication is requested. |
| `providers` / `catalog_only` | Optional generation or catalog inspection, mutually exclusive and disabled by default. |
| `provider_budget_usd` | Zero by default; explicit generation budgets cannot exceed 10 USD. |

Qualification binds the source revision, canonical code, pinned runtimes, both asset hashes and asset IDs. It tests clean installation, sandbox execution, update, idempotency, rollback, modified-file refusal and the installed extension lifecycle. The complete profile must pass before publication. Providers remain a separate optional assertion. Real checks run on disposable Actions runners; personal memory is never exported for them.

Publication uses `PI_DISTRIBUTION_TOKEN`, restricted to this repository with Contents read/write, Administration read and Attestations read. The token checks the immutable-release setting and verifies published attestations. A draft has no publication attestation: qualification downloads it through authenticated private access and validates its exact contents. Client downloads continue requiring immutable release attestations and matching asset hashes.

There is no separate published candidate or second output release. Before finalization, failures leave the draft unpublished. After finalization, verification failures may leave an immutable release; retain that evidence and inspect the state before another action. Legacy published releases remain installable through the normal verified downloader, but the new qualification workflow consumes drafts only.

## Credentials and provider cases

Configure secrets in **Settings → Secrets and variables → Actions** in the private repository, using the existing secure files or a secret manager. Never put their values in chat, workflow inputs, release assets, source files or logs.

| Name | Kind | Content |
| --- | --- | --- |
| `PI_DISTRIBUTION_TOKEN` | Secret | Fine-grained token for this repository only, Contents read/write, Administration read and Attestations read. Required only when publishing. |
| `PI_QUALIFICATION_AUTH_JSON` | Secret | Pi `auth.json` JSON for the explicitly selected authentication modes, when needed. |
| `PI_QUALIFICATION_PROVIDER_SECRETS_JSON` | Secret | The installed AI-provider extension's `config/ai-providers.secrets.json` JSON, when needed. |
| `PI_QUALIFICATION_PROVIDER_CASES` | Variable | A JSON array of 1–8 objects with `provider`, `model`, and `authMode` (`api-key`, `oauth`, or `subscription`). No credentials. |

Example case metadata, using deliberately fictional identifiers:

```json
[{"provider":"configured-provider","model":"configured-model","authMode":"api-key"}]
```

Credentials are injected only in the profile stage, after dependency installation. They are written with owner-only permissions and deleted at exit. The stage never uploads its raw output. Structured results include fixed failure classifications, extension paths, lifecycle events and installed-file stack locations, resource counts, tool names and provider identities. Before each generation request, a checkpoint records the modeled maximum cost and request start; a received response records cost and response shape before response validation. Raw response text and provider error messages are excluded. A failure after request start without a response leaves cost unknown: retain the reservation and do not automatically retry against the same total budget. A timeout still runs the workflow cleanup step. Private release data and logs are not uploaded as public artifacts.

Each selected case checks its actual configured authentication mode before network access. Qualification then refreshes only the selected provider catalogs with a 30-second deadline, because a fresh installation has no personal model cache. Refresh errors or cancellation stop qualification before any completion. Model availability and the budget reservation are checked against the refreshed metadata before a completion request. The test supplies an ephemeral conversation ID through the SDK for provider routing, sends a fixed minimal prompt, requests at most 2,048 output tokens (further bounded by the model limit) so reasoning models have room to produce answer text, disables SDK retries where supported, and imposes request/process timeouts. The budget gate reserves a whole configured context window per case using the maximum configured input/cache and output price tiers and stops if reported cumulative cost exceeds the budget. Configured prices and provider-reported costs are not an independent billing guarantee; configure the provider's own account/key spending limit for a hard financial ceiling. The test does not validate model quality, every model in the profile, or OAuth renewal after credentials expire. Rotated OAuth credentials on the runner are discarded and never synchronized back to the workstation.

Manual dispatch by the owner is the authorization gate. GitHub environment approval rules can be added when the account plan supports them; private-repository required reviewers are not assumed available. See [GitHub environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Evidence and failure handling

The private `private-portability-evidence` artifact contains structured `result.json`, `qualification.json`, `profile.json`, the draft `candidate.json` receipt, and `publication.json` when publication ran, retained for seven days. Missing profile evidence or `status: failed` is a failed or incomplete profile qualification, even if earlier installation milestones passed. Whole qualification jobs are never automatically retried. After publication only, the operator polls attestation verification up to 30 times at one-second intervals when GitHub reports no attestation yet; invalid signatures and other errors fail immediately. The draft is rechecked against its qualification receipt before finalization; published assets then pass through the normal client downloader. Keep the run URL, source SHA, bundle SHA and structured evidence with the release decision.

The public workflow performs two independent full runs on each of Ubuntu and WSL2, retaining logs for diagnosis. Its reusable native-runtime job rebuilds from pinned inputs and must pass the global typecheck and native contracts before downstream qualification starts. Historical failures remain recorded in the [CI report](verification/2026-10-31-portable-pi-ci.md).

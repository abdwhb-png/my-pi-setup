# Private portability qualification in GitHub Actions

Real personal-profile, publication and provider verification runs on disposable GitHub-hosted runners, never against the daily installation. The public workflow uses synthetic data. The private workflow must live in `abdwhb-png/my-pi-distribution`; it refuses another repository or an actor other than the repository owner. There are no push, pull-request or scheduled triggers for private checks.

## Private inputs

The distribution repository must be private, have an initialized default branch and have immutable releases enabled. Copy the canonical [private workflow](../.github/workflows/portable-private-qualification.yml) to its `.github/workflows/` directory without editing the generated copy. When changing the workflow, update this repository first and copy that file again. The qualification implementation remains in `my-pi-setup` and is checked out at the full reviewed commit supplied to each dispatch.

Supply a candidate through the private release UI: create a draft, attach the `setup.tgz` and `release.json` produced by `pi-setup pack`, then select `publish_candidate` when dispatching the workflow to finalize it as an immutable release on the runner. An already published immutable candidate can be used with that option disabled. Review the separate inventory before uploading. The candidate contains the actual portable profile and its pinned runtimes, but no authentication, sessions or memory. This initial candidate is an input, not qualification evidence. No workflow reads this workstation to create it. A changed setup implementation requires a new candidate built from that implementation; evidence records both the qualification-source commit and bundle-source commit.

The standard repository token reads releases. Publication requires the `PI_DISTRIBUTION_TOKEN` Actions secret: a fine-grained token restricted to this repository with Contents read/write, Administration read and Attestations read. The administration permission is needed to verify the immutable-release setting; the standard Actions token was rejected by that endpoint in a runner check. See the [official repository API permissions](https://docs.github.com/en/rest/repos/repos) and [attestation API permissions](https://docs.github.com/en/rest/repos/attestations). The attestation permission is also required for read-only verification with a fine-grained token. If a token is already configured, edit its repository permissions under GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens; updating permissions on the existing token does not require pasting its value again. Access to private package forks must be configured separately through the package Git credential channel if the profile requires them; the repository token does not grant access to unrelated private repositories.

## Dispatch

Run **Private Pi profile qualification** in the distribution repository with:

- `source_sha`: the full reviewed commit of `my-pi-setup` containing the qualification scripts.
- `candidate_release`: the immutable input release tag.
- `publish_candidate`: false by default; set true to authorize finalization of the uploaded draft on the runner. The workflow requires both candidate assets and enabled release immutability.
- `publish_tag`: empty for read/install qualification, or a new tag to explicitly authorize publication of another immutable release. Existing tags are never replaced.
- `providers`: false by default. Set true only to authorize the selected generation requests.
- `profile_only`: false by default. After full qualification of the same candidate, install it afresh and check the sandbox/profile without repeating update, rollback or modified-file tests. Evidence labels this scope and the omitted checks explicitly.
- `catalog_only`: false by default. Inspect selected authentication, refreshed catalog metadata and maximum modeled request costs without generation. Mutually exclusive with `providers`; uses `provider_budget_usd` for the reservation check.
- `provider_budget_usd`: zero by default. With `providers` explicitly enabled, zero permits only models whose input, output and cache rates are all zero. Positive budgets must not exceed 10 USD. The generation flag remains false by default.

The runner installs into a new long HOME containing spaces and Unicode. It verifies the private release and asset attestations, installs the actual package sources, runs the installed sandbox contract, updates, repeats the update, rolls back and checks modified-file refusal. Publication additionally verifies a fresh download and rejection of an altered asset. The profile stage loads the installed SDK and all selected extensions, checks resource diagnostics, starts and shuts down the extension lifecycle, and records registered tools. Optional memory transfer is covered separately by the public synthetic qualification without exporting personal memory. These are distinct assertions; successful installation alone does not prove profile startup or provider connectivity.

The shared installer test makes a synthetic second bundle to exercise transaction semantics. It does not represent an independently maintained future profile release. Native runtime compatibility is rebuilt and qualified by the public Ubuntu/WSL2 workflow from pinned source commits; it no longer depends on an earlier run's expiring artifact. Private personal-profile qualification currently runs on Ubuntu; the public mechanism qualification separately covers WSL2.

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

Each selected case checks its actual configured authentication mode before network access. Qualification then refreshes only the selected provider catalogs with a 30-second deadline, because a fresh installation has no personal model cache. Refresh errors or cancellation stop qualification before any completion. Model availability and the budget reservation are checked against the refreshed metadata before a completion request. The test sends a fixed minimal prompt, requests at most 16 output tokens, disables SDK retries where supported, and imposes request/process timeouts. The budget gate reserves a whole configured context window per case using the maximum configured input/cache and output price tiers and stops if reported cumulative cost exceeds the budget. Configured prices and provider-reported costs are not an independent billing guarantee; configure the provider's own account/key spending limit for a hard financial ceiling. The test does not validate model quality, every model in the profile, or OAuth renewal after credentials expire. Rotated OAuth credentials on the runner are discarded and never synchronized back to the workstation.

Manual dispatch by the owner is the authorization gate. GitHub environment approval rules can be added when the account plan supports them; private-repository required reviewers are not assumed available. See [GitHub environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Evidence and failure handling

The private `private-portability-evidence` artifact contains only `result.json`, `qualification.json`, and `profile.json` when those stages have run, retained for seven days. Missing profile evidence or `status: failed` is a failed or incomplete profile qualification, even if earlier installation milestones passed. Whole qualification jobs are never automatically retried. After publication only, the operator polls attestation verification up to 30 times at one-second intervals when GitHub reports no attestation yet; invalid signatures and other errors fail immediately. A newly finalized input candidate is verified by the downloader after host preparation and before extraction, avoiding a second publication-wait implementation in the bootstrap workflow. Keep the run URL, source SHA, bundle SHA and structured evidence with the release decision.

The public workflow performs two independent full runs on each of Ubuntu and WSL2, retaining logs for diagnosis. Its reusable native-runtime job rebuilds from pinned inputs and must pass the global typecheck and native contracts before downstream qualification starts. Historical failures remain recorded in the [CI report](verification/2026-10-31-portable-pi-ci.md).

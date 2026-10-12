# Code Review Report

**Date:** 2026-10-12

**Follow-up:** The F1–F4 corrections and their validation are recorded in [Review Corrections](review-corrections.md). This report retains the original verdict and evidence for its frozen scope.

**Scope:** Harness `3191b97fbd559e4825571c1d9b1680e92ec45fda..40f62f2eb2fe4570b053d462894089a39e940f14` and pi-subagents fork `7fcc8a42c93ededa7e299a9a6100122d84a51f7b..51799a79183170cde54ee9860491af860b97177b`. The unrelated agent/model changes in the harness baseline are excluded. Both tracked working trees were clean throughout review.

**Verdict:** REQUEST CHANGES

**Review Lanes:** L1 correctness/spec, L2 security, L3 architecture/boundaries, L4 interface/compatibility, and L5 performance. The user confirmed all five lanes. Each ran independently on a read-only `code-reviewer` agent and returned a complete final report.

## Summary

- **CRITICAL:** 0
- **HIGH:** 2
- **MEDIUM:** 2
- **LOW:** 0
- **Architectural Status:** BLOCK for the overview's suppressed diagnostics. The core discovery seam is CLEAR.

The core design follows [ADR-029](../../adr/ADR-029-runtime-subagent-tool-selection.md): normalization occurs after native precedence, the harness owns group policy, and launchers, runtime registrations, serialization, recovery and capability ceilings retain their existing owners. The review nevertheless reproduced two public-boundary defects in the fork and an overview projection that masks native rejection. Large-policy synchronous expansion has a separate nonblocking scalability cost.

The installed Git source was independently verified as `git:github.com/abdwhb-png/pi-subagents@v0.77.0+fork.1`, with exactly one configured source, manifest version `0.77.0+fork.1`, clone HEAD `51799a79183170cde54ee9860491af860b97177b`, and the harness import link resolving to that clone. These findings therefore concern code already installed. Review did not change runtime code, configuration or installation.

## Findings

### F1 [HIGH] Failure diagnostics override native name-match precedence

- **Location:** Fork `src/agents/agents.ts:292`, with source-priority comparison at line 301 and accepted identity construction at line 2970.
- **Issue:** `acceptedNames` treats canonical names, local names and aliases as equivalent matches. The diagnostic check then compares source priority across different agent identities, although native name resolution prefers canonical matches before local names and aliases.
- **Verified trigger:** A failed user agent named `alpha.worker` accepts local name `worker`. A healthy builtin has canonical name `worker`. Native `resolveAgentName("worker")` selects the builtin, but the failed user's diagnostic blocks its public preflight. A second fixture uses a failed project agent whose alias equals a healthy user agent's canonical name and reproduces the same root cause.
- **Risk:** A group-resolution failure for one agent denies a fresh launch of another valid agent. Public preflight returns `ok:false` with an invalid-configuration error for the wrong identity.
- **Suggested Fix:** Preserve native canonical, local and alias match precedence before comparing source priority. Keep diagnostics for failed qualified/local/alias requests and genuine shadowing. Add public-preflight collision coverage for both reproduced variants.
- **Evidence:** L1 reproduced the qualified/local case through awaited `resolveSubagentLaunchContract`. L4 reproduced the alias case through real discovery and native name/diagnostic resolution. Root independently reran the alias reproduction and confirmed the failed contract assertion.

### F2 [HIGH] Malformed provider arrays evade validation or crash public preflight

- **Location:** Fork `src/agents/host-tool-selection.ts:76`, result validation and deduplication at lines 77–79, and `src/agents/agents.ts:2966` and line 2978.
- **Issue:** `results.map()` skips sparse result slots. Cardinality is compared against the provider-mutable `request.selections.length`. The selector schema also accepts sparse arrays, which become `[undefined]` after deduplication. Missing results are treated like unselected agents, while invalid selector elements reach `splitToolList` outside the loader's error boundary.
- **Verified triggers:** `return new Array(selections.length)` and `request.selections.length = 0; return []` leave a fixture's original `read, write` configuration executable without a diagnostic. Public preflight returns `ok:true` with `write` in `effectiveAllowlist`. Returning `{ok:true, selectors:Array(1)}` causes discovery to throw and public preflight to reject with `Cannot read properties of undefined (reading 'startsWith')`.
- **Risk:** Malformed provider responses violate the documented failure contract. They can silently retain raw permissions or interrupt discovery instead of producing actionable per-agent diagnostics.
- **Boundary:** This requires malformed trusted global provider code. The supplied harness provider creates dense results and does not mutate the request. It is not an untrusted-project code execution exploit. A native `allowedTools:["read"]` capability ceiling still excludes `write` in every reproduced case.
- **Suggested Fix:** Snapshot the original batch cardinality before invoking provider code and use that original cardinality for both validation and failure construction. Validate every numeric result and selector index with dense iteration before deduplication. Treat missing results for selected agents as failures. Cover sparse results, sparse selectors and mutated request cardinality through discovery and public preflight.
- **Evidence:** L2 verified successful raw-permission preflight and intact capability ceilings. L4 verified discovery exceptions and public-preflight rejection. Root independently reproduced both sparse-selector failures. No model or child execution was required.

### F3 [MEDIUM] Overview disguises rejected agents as valid empty selections

- **Location:** Harness `agent/extensions/pi-subagents-addons/pi-subagents-overview/index.ts:254`, also builtin projection at line 227. Discovery diagnostics are discarded at lines 182–192.
- **Issue:** The overview reads effective tools, rescans raw declarations and substitutes `[]` when an agent has no effective selection. It does not retain the diagnostic explaining why native discovery omitted that agent.
- **Verified trigger:** A temporary user agent with `tools: @missing` is omitted from native executable discovery with `Group not found: @missing`. The actual overview factory and `/subagent-view` detail handler still display normal user details with `Tools: —` and no error. L1 and L3 independently reproduced this behavior.
- **Risk:** An unavailable agent is indistinguishable from a valid explicit empty selection. The overview suppresses the actionable failure needed to repair group configuration.
- **Suggested Fix:** Preserve native discovery diagnostics and show an explicit blocked/error state for omitted declarations. Alternatively, limit executable listings to effective agents and expose rejected declarations separately with their diagnostics. Add a command-boundary test for a missing group or provider alongside the valid empty-selection case.
- **Architectural Assessment:** L3 reports BLOCK specifically for this diagnostic-loss projection under the rule against masking failures. The native discovery seam and shared ownership remain CLEAR. The display defect stays MEDIUM rather than receiving an inflated severity.
- **Evidence Boundary:** The fixtures use real native discovery/provider imports and the actual overview command handler with a mocked registration host and home directory. They prove projection behavior, not a complete interactive Pi session.

### F4 [MEDIUM] Large policies repeat costly membership work for every agent

- **Location:** Harness `agent/extensions/pi-subagents-addons/tool-selection.ts:20`, using the existing shared `agent/extensions/_shared/tool-groups/resolver.ts:123` membership check.
- **Issue:** Each selection copies and filters all configured group members. Each expanded member then uses a linear `Array.includes` lookup. The new discovery-batch consumer repeats that existing resolver cost across agents on every effective discovery.
- **Verified trigger:** A valid synthetic batch with 200 selections and 5,000 configured members had warm provider medians of 111 ms when selecting the first group and 392 ms when selecting the last group. The observed maximum was 584 ms.
- **Risk:** Large configurations can synchronously delay discovery and launch planning. This is a scalability improvement, not a demonstrated blocking regression for ordinary policies.
- **Suggested Fix:** Prepare the concrete group pool once per batch and add a reusable membership index to the existing resolver. Preserve per-agent exact selectors, ordering, diagnostics and fresh policy reads. Do not introduce a compiled permission cache or a new resolution framework.
- **Ordinary-Size Evidence:** A synthetic 36-selection, 22-group, 66-member policy took 0.71–1.06 ms in the provider and 1.63–2.45 ms through the installed host resolver. The installed policy inventory supplied counts only and was not used as a fixture.

## Lane Recommendations

| Lane | Reviewer | Verdict | Findings and boundaries |
| --- | --- | --- | --- |
| L1 correctness/spec | `/root/runtime_review_l1` (`code-reviewer`) | REQUEST CHANGES | F1 and F3 reproduced. No additional migration or workflow regression confirmed. |
| L2 security | `/root/runtime_review_l2` (`code-reviewer`) | REQUEST CHANGES | F2 sparse results and request mutation confirmed through public preflight. Trust, export containment and migration adversarial checks passed. |
| L3 architecture/boundaries | `/root/runtime_review_l3` (`code-reviewer`) | REQUEST CHANGES | BLOCK for F3 diagnostic masking. Core discovery seam CLEAR and import boundaries passed. |
| L4 interface/compatibility | `/root/runtime_review_l4` (`code-reviewer`) | REQUEST CHANGES | F1 alias variant and F2 sparse-selector exception confirmed. Source/compiled export shapes agree. |
| L5 performance | `/root/runtime_review_l5` (`code-reviewer`) | COMMENT | F4 large-policy cost measured. No blocking ordinary-policy performance regression established. |

L1 rates F1 HIGH; L4 rates its alias variant MEDIUM. The consolidated severity is HIGH because a valid native public launch is denied contrary to canonical identity precedence. Overlapping findings are counted once.

## Validation and Limits

Fresh review checks overlap and are not summed into a unique test total:

- **L1:** 80 fork discovery/override tests, 18 focused harness provider/migration/reader/overview tests, and nine addon/workflow visibility tests passed. Independent fixtures reproduced F1 and F3.
- **L2:** 15 fork loader tests, 29 focused harness tests, four public-preflight reproduction tests and four additional migration safety tests passed. The reproduction tests assert the defective behavior and intact capability ceilings.
- **L3:** `bun run lint:boundaries` from `agent/` passed with warnings. The real overview command fixture reproduced F3.
- **L4:** Two positive provider-loading probes passed for relative TypeScript and ESM JavaScript paths, exact child-tool selectors, literal MCP selectors and deduplication. Three contract assertions failed as expected for F1 and F2. Both frozen diffs passed `git diff --check`.
- **L5:** 15 fork loader tests and nine harness provider tests passed. Sequential isolated Bun 1.3.14 microbenchmarks imported real production modules and compared the frozen baseline where applicable.
- **Root:** Independently reran L4's three failing contract assertions, checked the implicated source branches, and verified the configured Git source, installed manifest, clone SHA and import link.

The migration adversarial checks rejected settings, parent and journal symlinks, preserved an injected noncooperating edit with an explicit concurrent-edit error, released locks, and verified journal mode `0600` without unrelated synthetic settings fields. These checks do not prove protection against arbitrary hostile same-user inode races.

The earlier static Jiti/TypeBox import regression is fixed. Cold agents/status import measurements had overlapping ranges and did not establish a causal regression. First installed-provider loading took 2.80–3.24 seconds in isolated cold children or 1.20–1.71 seconds after SDK preload, then approximately 2 ms warm. These isolated measurements do not establish the cause of the previously recorded integration timeout. No exclusive CPU reservation, OS-cache control or real interactive status-loop benchmark was performed.

No complete suites, full typechecks, fresh compiled-package build, dependency audit, real remote provider calls or release/cutover qualification were rerun for this review. L4 inspected source exports and the build export transformation but did not treat the checkout's stale ignored `dist-pkg` as current build evidence. The earlier qualification record remains historical evidence, including its reproduced baseline failures and fluctuating timeout, rather than a fresh green review gate. No review lane failed or remained pending.

## Existing Documentation Debt

The addon README introduction at `agent/extensions/pi-subagents-addons/README.md:3` still describes generated overrides, and line 5 still describes the former official `0.73.1` npm installation. Those preexisting paragraphs contradict the rewritten runtime-selection and Git-installation sections. Update them when correcting the reviewed defects. This debt is recorded separately from the introduced finding counts.

## Reproduction Artifacts

The following temporary artifacts were retained for immediate reproduction. They are not repository regression tests:

- F1 and sparse-selector F2: `/tmp/l4-public-interface-review-20261012.mjs`. Run `node --experimental-strip-types --test` on this file from the fork root. Three expected contract assertions fail on the reviewed implementation.
- Sparse-result and mutated-request F2: `/tmp/pi-runtime-security-review-G4Azvt/provider-output.test.ts`. Run `node --experimental-strip-types --test` on this file from the fork root. Four tests confirm the defective permission behavior and intact ceilings.
- F3: `/tmp/pi-runtime-review-l3-overview.ts`. Run `bun` on this file from the harness `agent/` root.
- Migration safety: `/tmp/pi-runtime-security-review-G4Azvt/migration-safety.test.ts`. Run `bun test --isolate` on this file from the harness `agent/` root.
- L5 raw measurements: `/tmp/pi-l5-review-taoq_llb/results.json` and `followup-results.json`.

## Final Recommendation

**REQUEST CHANGES:** Correct F1 and F2 in the fork and preserve native failure evidence in the overview for F3, using focused public-boundary regressions. F4 is a measured nonblocking optimization for large policies. This review performed no implementation fixes, configuration changes, package installation, commit, push or Pi core promotion. Only this report was added to the harness repository.

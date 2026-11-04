# Setup usability and provider availability implementation plan

**Goal:** Make setup operations observable, include global skills only on explicit request, and publish CPA models only while their catalog is verified.

**Decisions:** Global skills remain available through `pack --include-global-skills`; native Pi initial model fallback remains unchanged. Repository skills and package resources remain included. Real installation qualification runs in GitHub Actions, without paid generation or activation of the workstation runtime. Changes to the Pi core fork require separate explicit user authorization; this setup work does not authorize them.

- [x] Add failing packaging tests for default exclusion, explicit inclusion, resource selection, and upgrade migration; implement the option in the existing profile capture owner.
- [x] Add public CLI regressions for contextual help, usage diagnostics, missing installations, concise previews, and observable progress before subprocess completion; implement asynchronous long-running commands, safe stage events, elapsed feedback, and contextual outcomes.
- [x] Replace CPA fallback availability with explicit verified/empty/unavailable results; test startup, authentication and transport failures, cache retention, recovery, metadata reprojection, input/compaction gates, and diagnostic deduplication.
- [x] Withdraw the unauthorized Pi fork selector, test and workflow changes. Keep the scoped-selector behavior as an unresolved runtime limitation; do not treat a fork rebuild as a prerequisite authorized by this task.
- [x] Extend setup CI qualification for both packaging policies and CPA lifecycle/network fixtures without modifying the Pi fork or promoting a runtime.
- [x] Integrate CPA with Pi's public `refreshModels` callback, sharing catalog verification with the lifecycle gates. Keep an empty provider registration during outages so native refresh can recover it. Preserve scoped preferences; cover offline initialization, superseded publications and metadata reprojection. Extend the CI-only runtime contract to exercise native refresh.
- [x] Run focused tests, formatting, types, ownership boundaries and relevant lint; update the portable setup documentation and release skill. Preserve unrelated changes. Report CI checks not executed and keep commit, push, main promotion and publication separate.

Use RED → GREEN for behavior changes. Keep existing archive admission, secret rejection, runtime locking, integrity checks and modified-file refusal. Progress belongs on stderr; cleanup's existing JSON stdout remains compatible. No automatically retained operator logs.

Implementation evidence and remaining qualification boundaries are recorded in [the verification report](../../verification/2026-11-04-setup-usability-and-provider-availability.md). Setup CI execution remains pending. The fork changes were withdrawn on 2026-11-04 after the user rejected the unauthorized scope expansion; no fork modification or new runtime is part of this delivery.

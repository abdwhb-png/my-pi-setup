# Sandbox install verification reference

`verifySandboxInstall` is the layer for **pre-publish** validation. It does a full real install of your package into a temp directory (no mocking) and confirms the package actually loads, registers its extensions/tools/skills, and (optionally) executes its tools end-to-end inside that real install.

This catches a class of bugs that `createTestSession` cannot: broken `package.json` `exports` maps, missing `peerDependencies`, wrong `main`/`types`/`module` fields, files missing from `"files"`, ESM/CJS dual-publish issues. All of these can pass local tests while breaking the moment someone runs `npm install your-package`.

## When to use it

| Test layer                 | What it catches                                            |
| -------------------------- | ---------------------------------------------------------- |
| `createTestSession`        | Extension logic bugs (hook firing, tool behavior, events)  |
| **`verifySandboxInstall`** | **Publishable-package bugs (broken install, bad exports)** |
| `createMockPi`             | Subprocess-spawning extension bugs                         |

Run `verifySandboxInstall` as a CI step before every publish, or locally as `npm run prepack` / `npm publish --dry-run`. At least [`marcfargas/pi-mf-extensions`](https://github.com/marcfargas/pi-mf-extensions) (pi-planner) uses this layer to test the plan lifecycle; check its CI for a concrete release-gate example.

## Basic usage

```typescript
import { verifySandboxInstall } from "@marcfargas/pi-test-harness";

const result = await verifySandboxInstall({
  packageDir: "./packages/my-extension",
  expect: {
    extensions: 1,
    tools: ["my_tool", "my_other_tool"],
    skills: 0,
  },
});

expect(result.loaded.extensionErrors).toEqual([]);
expect(result.loaded.tools).toContain("my_tool");
```

What it does, step by step:

1. Reads `package.json` from `packageDir`.
2. Runs `npm pack` to produce a tarball exactly as `npm publish` would.
3. Creates a temp directory.
4. Runs `npm install <tarball>` inside the temp dir — a real install with real peer-dep resolution.
5. Dynamically imports the installed package.
6. Hands you the loaded state so you can assert extensions/tools/skills were registered.

## Options

| Option              | Type                              | Purpose                                           |
| ------------------- | --------------------------------- | ------------------------------------------------- |
| `packageDir`        | `string`                          | Path to the package (must contain `package.json`) |
| `expect.extensions` | `number`                          | How many extensions should have loaded            |
| `expect.tools`      | `string[]`                        | Required tool names                               |
| `expect.skills`     | `number`                          | How many skills should have loaded                |
| `smoke`             | `{ mockTools, script }`           | Optional in-sandbox playbook smoke test           |
| `smoke.mockTools`   | `Record<string, MockToolHandler>` | Same as `createTestSession`'s `mockTools`         |
| `smoke.script`      | `Turn[]`                          | Playbook turns (built with `when / calls / says`) |

## Smoke test inside the sandbox

Once the package is installed and loaded, you can drive it through a real playbook against the in-sandbox instance. This is the strongest possible signal short of a beta release: not only does the package install and load, its tools actually execute when called.

```typescript
import {
  verifySandboxInstall,
  when, calls, says,
} from "@marcfargas/pi-test-harness";

const result = await verifySandboxInstall({
  packageDir: "./packages/my-extension",
  expect: { extensions: 1 },
  smoke: {
    mockTools: {
      bash: "ok",
      read: "contents",
      write: "written",
      edit: "edited",
    },
    script: [
      when("Test", [
        calls("my_tool", { value: "test" }),
        says("Works."),
      ]),
    ],
  },
});

expect(result.loaded.extensionErrors).toEqual([]);
expect(result.smoke.toolResultsFor("my_tool")).toHaveLength(1);
```

`result.smoke` exposes the same `TestEvents` API as `createTestSession`, so you can assert against events exactly as you would in an in-process test.

## How this differs from `createTestSession`

It's worth being explicit because the layers overlap conceptually but solve different problems:

| Diagnostic question                                | Use                        |
| -------------------------------------------------- | -------------------------- |
| Does my extension's hook fire and block correctly? | `createTestSession`        |
| Does the tool's logic do the right thing?          | `createTestSession`        |
| **Does the package I'm about to publish install?** | **`verifySandboxInstall`** |
| **Are the right files included in the tarball?**   | **`verifySandboxInstall`** |
| **Do peer deps resolve in a clean install?**       | **`verifySandboxInstall`** |

In practice, the natural split is: use `createTestSession` for the bulk of behavioral tests (it's fast, in-process, and exercises the extension under test directly), and reserve `verifySandboxInstall` for a single release-gate CI test (it's slower because it runs a real `npm pack` + `npm install`). The release gate catches things like forgetting to add a new tool's source file to the package's `"files"` list (which would make local `createTestSession` pass but a published package throw).

## Common pitfalls

- **Expecting `verifySandboxInstall` to mock anything by default.** It doesn't — only the optional `smoke` step uses mocks. The install + load itself is fully real.
- **Putting `packageDir` as the package name instead of a path.** It's a directory path, not an npm spec.
- **Expecting `tools` to be exhaustive.** If `expect.tools` lists `["my_tool", "my_other_tool"]` and your package also registers `my_third_tool`, the test still passes — but `my_third_tool` not being listed usually means you forgot to update the spec when you added a tool. Assert **all** tools.
- **CI cost.** A real `npm pack` + `npm install` per test file is slow. Most projects run `verifySandboxInstall` exactly once, in a release-gate test, not in every test file.

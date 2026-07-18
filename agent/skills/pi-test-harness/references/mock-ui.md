# Mock UI reference

Pi extensions interact with users via `ctx.ui.*` methods (`confirm`, `select`, `input`, `editor`, `notify`). In tests, those calls would block waiting for real input. `mockUI` controls what they "return" so you can drive extensions through their interactive code paths deterministically.

Every UI call is also recorded for assertions afterwards via `t.events.uiCallsFor(name)`.

## The full interface

```typescript
interface MockUIConfig {
  confirm?: boolean | ((title: string, message: string) => boolean);
  select?: number | string | ((title: string, items: string[]) => string | undefined);
  input?: string | ((title: string, placeholder?: string) => string | undefined);
  editor?: string | ((title: string, prefilled?: string) => string | undefined);
}
```

Each field can be either a **static value** (returned for every call) or a **function** (computed per call). Static values are great for "always say yes" / "always pick the first option" defaults. Functions let you make different decisions based on the prompt context.

## Defaults

If you don't pass `mockUI` at all, these defaults apply:

| Method   | Default                              |
|----------|--------------------------------------|
| `confirm`| `true` (accept all)                  |
| `select` | `0` (first item)                     |
| `input`  | `""` (empty string)                  |
| `editor` | `""` (empty string)                  |

In practice: if your extension calls `confirm` and you don't mock it, it returns `true` and the operation proceeds. This is convenient but can mask bugs where your extension shouldn't have called `confirm` at all.

**Tip**: in tests that *shouldn't* trigger UI calls, explicitly set empty configs and assert `t.events.uiCallsFor("confirm")` has length 0 — that catches accidental prompts.

## The four methods in detail

### `confirm(title, message) → boolean`

Yes/no confirmations.

**Static form** — same answer every time:

```typescript
mockUI: {
  confirm: false,   // deny all confirmations
}
```

**Dynamic form** — different answer depending on the prompt:

```typescript
mockUI: {
  confirm: (title, _message) => {
    if (title.includes("Delete")) return false;
    if (title.includes("Overwrite")) return false;
    return true;
  },
}
```

### `select(title, items) → string`

Picking from a list.

**Static forms**: index or the item itself.

```typescript
mockUI: {
  select: 0,                    // always pick first item
  // or:
  select: "staging",            // pick the matching item (must be exact)
}
```

**Dynamic form**:

```typescript
mockUI: {
  select: (_title, items) => items.find(i => i.includes("staging")),
}
```

Returning `undefined` from a dynamic handler simulates "user selected nothing".

### `input(title, placeholder?) → string`

Free-text input.

```typescript
mockUI: {
  input: "user input text",                                      // static
  // or:
  input: (title, _placeholder) => title.includes("name") ? "bob" : "x",
}
```

### `editor(title, prefilled?) → string`

Multi-line editor (typically opens `$EDITOR` in real Pi). Returns the edited content.

```typescript
mockUI: {
  editor: "edited content",                                      // static
  // or:
  editor: (_title, prefilled) => `${prefilled}\n# Appended section\n`,
}
```

## Asserting on UI calls

All UI interactions are recorded in `t.events`:

```typescript
t.events.uiCallsFor("confirm")   // UICallRecord[]
t.events.uiCallsFor("select")
t.events.uiCallsFor("input")
t.events.uiCallsFor("editor")
t.events.uiCallsFor("notify")    // also collected, even though it's not mocked
```

Each record contains the call's title, the other arguments, and the `returnValue` the mock produced. This is how you prove your extension asked the right question and got the right shape of response.

### Common assertions

```typescript
// My extension should ask for confirmation exactly once
expect(t.events.uiCallsFor("confirm")).toHaveLength(1);

// And the user answered with the expected response
expect(t.events.uiCallsFor("confirm")[0].returnValue).toBe(false);

// My extension should NOT have prompted for free-form input
expect(t.events.uiCallsFor("input")).toHaveLength(0);
```

## When to override defaults

| Situation                                                                  | Recommendation                                  |
|----------------------------------------------------------------------------|--------------------------------------------------|
| Test should never hit a UI prompt                                          | Assert `uiCallsFor(X)` len 0; don't bother with `mockUI` |
| Test passes only if user denies a destructive op                          | `mockUI: { confirm: false }` + assert hit count  |
| Extension branch depends on which option was selected                      | `mockUI: { select: "value" }` or dynamic handler |
| Test exercises an `input` form                                             | `mockUI: { input: "value" }` — never accept the empty default for an actual input test |

## Pitfalls

- **Forgetting `notify` is recorded**. `notify` calls don't need mocking (they're outbound), but they show up in `uiCallsFor("notify")` and are very useful for asserting the user was warned about something.
- **Static `select: 0` masking missing-item bugs**. If your extension's `select` didn't list the expected option, the mock silently returns whatever item is first. Assert on the *full call arguments* (`uiCallsFor("select")[0]`) if you care which options were presented.
- **`input: ""` default hiding "did the extension read user input?" bugs**. If your extension is supposed to read input but accidentally skips it, the default-empty mock won't trip. Explicit non-empty input + subsequent assertion is the safer pattern.

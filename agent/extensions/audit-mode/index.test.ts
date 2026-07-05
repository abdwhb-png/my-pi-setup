/**
 * Tests for the audit-mode owner extension.
 *
 * Uses bun:test. Mocks @earendil-works/pi-coding-agent since it requires
 * the pi runtime. Imports the real shared audit-mode modules directly.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

// ─── Mock pi framework ───────────────────────────────────────────────────────

type NotifySeverity = "info" | "warning" | "error";
type EventHandler = (...args: never[]) => void;

type NotifyCall = [message: string, severity: NotifySeverity];
const mockNotify = mock<(...args: NotifyCall) => void>();
const mockCtx = {
  cwd: "/tmp/test-project",
  ui: { notify: mockNotify },
};

const eventHandlers: Record<string, EventHandler> = {};
let commandHandler: ((args: string, ctx: typeof mockCtx) => void) | null = null;
let completionsFn: ((prefix: string) => { value: string; label: string }[] | null) | null = null;

const mockPi = {
  on: mock((event: string, handler: EventHandler) => {
    eventHandlers[event] = handler;
  }),
  registerCommand: mock(
    (
      _name: string,
      opts: {
        handler: (args: string, ctx: typeof mockCtx) => void;
        getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
      },
    ) => {
      commandHandler = opts.handler;
      completionsFn = opts.getArgumentCompletions ?? null;
    },
  ),
};

// ─── Configurable SettingsManager factory ────────────────────────────────────
// Tests set `settingsFactory` to control what each `fireSessionStart` returns.

type SettingsFactory = (cwd: string) => {
  getGlobalSettings: () => Record<string, object>;
  getProjectSettings: () => Record<string, object>;
};

let settingsFactory: SettingsFactory = (_cwd) => ({
  getGlobalSettings: () => ({}),
  getProjectSettings: () => ({}),
});

void mock.module("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: {
    create: (cwd: string) => settingsFactory(cwd),
  },
}));

// ─── Dynamic import after mock setup ────────────────────────────────────────

const { default: activate } = await import("./index.ts");

// Activate the extension with the mock pi object.
// The mock only implements the slim API surface this test exercises; the real
// `ExtensionAPI` is large and repo lint forbids `unknown`, so we bypass it.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
activate(mockPi as Parameters<typeof activate>[0]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Import state helpers to verify shared state transitions.
const { getActiveProfile, resetAuditState, getActivePolicy } = await import(
  "../_shared/audit-mode/audit-state.ts"
);

async function fireSessionStart(cwd = "/tmp/test-project"): Promise<void> {
  const handler = eventHandlers["session_start"];
  if (!handler) throw new Error("session_start handler not registered");
  await Promise.resolve(handler({}, { ...mockCtx, cwd }));
}

async function runCommand(args: string): Promise<void> {
  if (!commandHandler) throw new Error("command handler not registered");
  await Promise.resolve(commandHandler(args, mockCtx));
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe("audit-mode extension — registration", () => {
  it("registers session_start handler", () => {
    expect(eventHandlers["session_start"]).toBeDefined();
  });

  it("registers audit-mode command", () => {
    expect(mockPi.registerCommand.mock.calls.length).toBeGreaterThan(0);
    expect(mockPi.registerCommand.mock.calls[0][0]).toBe("audit-mode");
  });
});

describe("audit-mode extension — session_start", () => {
  beforeEach(() => {
    resetAuditState();
    mockNotify.mockReset();
    // Reset to empty settings by default
    settingsFactory = (_cwd) => ({
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    });
  });

  it("initializes to standard profile by default", async () => {
    await fireSessionStart();
    expect(getActiveProfile()).toBe("standard");
  });

  it("initializes to configured defaultProfile via real session_start path", async () => {
    settingsFactory = (_cwd) => ({
      getGlobalSettings: () => ({ auditMode: { defaultProfile: "audit" } }),
      getProjectSettings: () => ({}),
    });
    await fireSessionStart();
    expect(getActiveProfile()).toBe("audit");
  });

  it("falls back to standard profile when settings load throws", async () => {
    settingsFactory = (_cwd) => {
      throw new Error("settings unavailable");
    };
    await fireSessionStart();
    expect(getActiveProfile()).toBe("standard");
  });

  it("detects project override when project settings contain auditMode", async () => {
    settingsFactory = (_cwd) => ({
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({ auditMode: { defaultProfile: "advanced" } }),
    });
    await fireSessionStart();
    mockNotify.mockReset();
    await runCommand("status");
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toMatch(/project config: YES/i);
  });

  it("reports no project override when project settings are empty", async () => {
    settingsFactory = (_cwd) => ({
      getGlobalSettings: () => ({ auditMode: { defaultProfile: "audit" } }),
      getProjectSettings: () => ({}),
    });
    await fireSessionStart();
    mockNotify.mockReset();
    await runCommand("status");
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toMatch(/project config: NO/i);
  });
});

describe("audit-mode command — on", () => {
  beforeEach(() => {
    resetAuditState();
    mockNotify.mockReset();
  });

  it("activates audit profile", async () => {
    await runCommand("on");
    expect(getActiveProfile()).toBe("audit");
  });

  it("notifies user when activating", async () => {
    await runCommand("on");
    expect(mockNotify.mock.calls.length).toBeGreaterThan(0);
    const lastMsg = mockNotify.mock.calls[mockNotify.mock.calls.length - 1][0];
    expect(lastMsg.toLowerCase()).toContain("audit");
  });
});

describe("audit-mode command — advanced", () => {
  beforeEach(() => {
    resetAuditState();
    mockNotify.mockReset();
  });

  it("activates advanced profile", async () => {
    await runCommand("advanced");
    expect(getActiveProfile()).toBe("advanced");
  });

  it("notifies user when activating advanced", async () => {
    await runCommand("advanced");
    const lastMsg = mockNotify.mock.calls[mockNotify.mock.calls.length - 1][0];
    expect(lastMsg.toLowerCase()).toContain("advanced");
  });
});

describe("audit-mode command — off", () => {
  beforeEach(() => {
    resetAuditState();
    mockNotify.mockReset();
  });

  it("resets to standard profile", async () => {
    await runCommand("on");
    await runCommand("off");
    expect(getActiveProfile()).toBe("standard");
  });

  it("notifies user when deactivating", async () => {
    await runCommand("on");
    mockNotify.mockReset();
    await runCommand("off");
    expect(mockNotify.mock.calls.length).toBeGreaterThan(0);
    const lastMsg = mockNotify.mock.calls[mockNotify.mock.calls.length - 1][0];
    expect(lastMsg.toLowerCase()).toContain("standard");
  });
});

describe("audit-mode command — status", () => {
  beforeEach(() => {
    resetAuditState();
    mockNotify.mockReset();
  });

  it("displays active profile in status output", async () => {
    await runCommand("status");
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain("standard");
  });

  it("displays resolved flags in status output", async () => {
    await runCommand("status");
    const msg = mockNotify.mock.calls[0][0];
    // At least one known policy flag key should appear
    expect(msg).toMatch(/enforce|hidden|gitignore|compression/i);
  });

  it("shows whether project config overrides global", async () => {
    await runCommand("status");
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toMatch(/project override|no project override|project config/i);
  });

  it("status reflects active profile after command change", async () => {
    await runCommand("advanced");
    mockNotify.mockReset();
    await runCommand("status");
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain("advanced");
  });
});

describe("audit-mode command — unknown arg", () => {
  beforeEach(() => {
    resetAuditState();
    mockNotify.mockReset();
  });

  it("shows usage error for unrecognized argument", async () => {
    await runCommand("foo");
    const call = mockNotify.mock.calls.find(
      (c) => c[1] === "error" || c[0].toLowerCase().includes("usage"),
    );
    expect(call).toBeDefined();
  });
});

describe("audit-mode command — completions", () => {
  it("returns all subcommands on empty prefix", () => {
    const completions = completionsFn?.("") ?? [];
    const values = completions.map((c) => c.value);
    expect(values).toContain("on");
    expect(values).toContain("off");
    expect(values).toContain("advanced");
    expect(values).toContain("status");
  });

  it("filters completions by prefix", () => {
    const completions = completionsFn?.("a") ?? [];
    const values = completions.map((c) => c.value);
    expect(values).toContain("advanced");
    expect(values).not.toContain("on");
  });
});

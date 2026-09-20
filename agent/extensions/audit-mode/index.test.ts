/**
 * Tests for the audit-mode owner extension.
 *
 * Exercises registration and commands through the real Pi runtime.
 */

import { mock, describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import activate, { renderAuditWidget } from "./index.ts";

// ─── Mock pi framework ───────────────────────────────────────────────────────

type NotifySeverity = "info" | "warning" | "error";

type NotifyCall = [message: string, severity: NotifySeverity];
const mockNotify = mock<(...args: NotifyCall) => void>();
const session = await createTestSession({ extensionFactories: [activate] });
const runner = session.session.extensionRunner;
if (!runner) throw new Error("Pi extension runtime unavailable");
runner.setUIContext({ ...runner.createContext().ui, notify: mockNotify });
const command = runner.getCommand("audit-mode");
const completionsFn = command?.getArgumentCompletions;

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

const settingsSpy = spyOn(SettingsManager, "create").mockImplementation(cwd => {
  const fixture = settingsFactory(cwd ?? session.cwd);
  const manager = SettingsManager.inMemory();
  spyOn(manager, "getGlobalSettings").mockImplementation(fixture.getGlobalSettings);
  spyOn(manager, "getProjectSettings").mockImplementation(fixture.getProjectSettings);
  return manager;
});
afterAll(async () => {
  settingsSpy.mockRestore();
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Import state helpers to verify shared state transitions.
const { getActiveProfile, resetAuditState, getActivePolicy } = await import(
  "../_shared/audit-mode/audit-state.ts"
);

async function fireSessionStart(): Promise<void> {
  await runner.emit({ type: "session_start", reason: "resume" });
}

async function runCommand(args: string): Promise<void> {
  if (!command) throw new Error("command handler not registered");
  await command.handler(args, runner.createCommandContext());
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe("audit-mode extension — registration", () => {
  it("registers session_start handler", () => {
    expect(runner.hasHandlers("session_start")).toBe(true);
  });

  it("registers audit-mode command", () => {
    expect(runner.getRegisteredCommands().map(value => value.name)).toContain("audit-mode");
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
  it("returns all subcommands on empty prefix", async () => {
    const completions = await completionsFn?.("") ?? [];
    const values = completions.map((c) => c.value);
    expect(values).toContain("on");
    expect(values).toContain("off");
    expect(values).toContain("advanced");
    expect(values).toContain("status");
  });

  it("filters completions by prefix", async () => {
    const completions = await completionsFn?.("a") ?? [];
    const values = completions.map((c) => c.value);
    expect(values).toContain("advanced");
    expect(values).not.toContain("on");
  });
});

describe("renderAuditWidget", () => {
  function render(profile: "standard" | "audit" | "advanced") {
    const calls: Array<[string, string]> = [];
    const theme = {
      fg: (color: string, text: string) => {
        calls.push([color, text]);
        return `fg:${color}:${text}`;
      },
    } as never;
    return { output: renderAuditWidget(theme, profile), calls };
  }

  it("returns null for the standard profile", () => {
    expect(render("standard").output).toBeNull();
  });

  it("keeps the label dim", () => {
    expect(render("audit").calls.some(([color]) => color === "dim")).toBe(true);
  });

  it("colors only the audit value warning", () => {
    expect(render("audit").calls).toContainEqual(["warning", "audit"]);
  });

  it("colors only the advanced value accent", () => {
    expect(render("advanced").calls).toContainEqual(["accent", "advanced"]);
  });
});

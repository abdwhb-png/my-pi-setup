import { afterEach, describe, expect, it, mock } from "bun:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import piEnhancedFork from "./index.ts";

type Handler = (...args: unknown[]) => unknown;

interface MockApi {
  commands: Map<string, { handler: Handler; description: string }>;
  events: Map<string, Handler[]>;
  pi: {
    registerCommand(
      name: string,
      command: { handler: Handler; description: string },
    ): void;
    on(event: string, handler: Handler): void;
  };
}

afterEach(() => {
  setKittyProtocolActive(false);
});

function createApi(): MockApi {
  const commands = new Map<string, { handler: Handler; description: string }>();
  const events = new Map<string, Handler[]>();
  return {
    commands,
    events,
    pi: {
      registerCommand: (name, command) => commands.set(name, command),
      on: (event, handler) =>
        events.set(event, [...(events.get(event) ?? []), handler]),
    },
  };
}

function createUi(editorText: string) {
  let terminalHandler: ((data: string) => unknown) | undefined;
  const unsubscribe = mock(() => undefined);
  const ui = {
    getEditorText: mock(() => editorText),
    setEditorText: mock((text: string) => {
      editorText = text;
    }),
    onTerminalInput: mock((handler: (data: string) => unknown) => {
      terminalHandler = handler;
      return unsubscribe;
    }),
    notify: mock(() => undefined),
  };
  return { ui, unsubscribe, getTerminalHandler: () => terminalHandler };
}

function install(api: MockApi, ui: ReturnType<typeof createUi>["ui"]): void {
  const sessionStart = api.events.get("session_start")?.[0];
  expect(sessionStart).toBeFunction();
  sessionStart?.({}, { ui });
}

describe("/fork submit shim", () => {
  it("rewrites exact /fork for legacy and Kitty Enter without consuming input", () => {
    for (const enter of ["\r", "\x1b[13u"]) {
      const api = createApi();
      piEnhancedFork(api.pi as never);
      const editor = createUi("  /fork  ");
      install(api, editor.ui);

      const result = editor.getTerminalHandler()?.(enter);

      expect(result).toBeUndefined();
      expect(editor.ui.setEditorText).toHaveBeenCalledWith("/efork");
    }
  });

  it("does not rewrite arguments, messages, other commands, or non-Enter input", () => {
    const values = [
      "/fork extra",
      "please run /fork",
      "/efork",
      "/other",
      "ordinary message",
    ];

    for (const value of values) {
      const api = createApi();
      piEnhancedFork(api.pi as never);
      const editor = createUi(value);
      install(api, editor.ui);
      editor.getTerminalHandler()?.("\r");
      expect(editor.ui.setEditorText).not.toHaveBeenCalled();
    }

    const api = createApi();
    piEnhancedFork(api.pi as never);
    const editor = createUi("/fork");
    install(api, editor.ui);
    editor.getTerminalHandler()?.("x");
    expect(editor.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("does not rewrite Shift+Enter or Kitty release events", () => {
    setKittyProtocolActive(true);
    for (const input of ["\n", "\x1b[13;2u", "\x1b[13;1:3u"]) {
      const api = createApi();
      piEnhancedFork(api.pi as never);
      const editor = createUi("/fork");
      install(api, editor.ui);
      editor.getTerminalHandler()?.(input);
      expect(editor.ui.setEditorText).not.toHaveBeenCalled();
    }
  });

  it("unsubscribes before reinstall and on session shutdown", () => {
    const api = createApi();
    piEnhancedFork(api.pi as never);
    const first = createUi("/fork");
    const second = createUi("/fork");

    install(api, first.ui);
    install(api, second.ui);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);

    const sessionShutdown = api.events.get("session_shutdown")?.[0];
    expect(sessionShutdown).toBeFunction();
    sessionShutdown?.({}, {});
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps /efork usable when the shim is disabled", async () => {
    const previous = process.env.PI_ENHANCED_FORK_SHIM;
    process.env.PI_ENHANCED_FORK_SHIM = "off";
    try {
      const api = createApi();
      piEnhancedFork(api.pi as never);
      const editor = createUi("/fork");
      install(api, editor.ui);
      expect(editor.ui.onTerminalInput).not.toHaveBeenCalled();

      const efork = api.commands.get("efork");
      expect(efork).toBeDefined();
      const notify = mock(() => undefined);
      await efork?.handler("", {
        hasUI: true,
        isIdle: () => true,
        sessionManager: { getEntries: () => [] },
        ui: { notify },
      });
      expect(notify).toHaveBeenCalledWith(
        "No user messages to fork from",
        "warning",
      );
    } finally {
      if (previous === undefined) delete process.env.PI_ENHANCED_FORK_SHIM;
      else process.env.PI_ENHANCED_FORK_SHIM = previous;
    }
  });

  it("keeps /efork registered when terminal-listener installation fails", () => {
    const api = createApi();
    piEnhancedFork(api.pi as never);
    const editor = createUi("/fork");
    editor.ui.onTerminalInput.mockImplementation(() => {
      throw new Error("listener unavailable");
    });

    expect(() => install(api, editor.ui)).not.toThrow();
    expect(api.commands.has("efork")).toBeTrue();
    expect(editor.ui.notify).toHaveBeenCalledWith(
      "Enhanced /fork shim unavailable; use /efork",
      "warning",
    );
  });
});

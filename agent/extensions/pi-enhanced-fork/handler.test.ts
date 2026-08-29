import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const extensionModule = (await import("./index.ts")) as Record<
  string,
  unknown
>;

type RunEnhancedFork = (ctx: TestContext) => Promise<void>;

interface TestContext {
  hasUI: boolean;
  isIdle(): boolean;
  sessionManager: { getEntries(): unknown[] };
  ui: {
    custom: ReturnType<typeof mock>;
    notify: ReturnType<typeof mock>;
  };
  fork: ReturnType<typeof mock>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

function userEntry(id: string, content: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-29T00:00:00.000Z",
    message: { role: "user", content, timestamp: 0 },
  };
}

function createContext(
  entries: unknown[],
  selectedId: string | undefined,
): TestContext {
  return {
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getEntries: () => entries },
    ui: {
      custom: mock(async () => selectedId),
      notify: mock(() => undefined),
    },
    fork: mock(async () => ({ cancelled: false })),
  };
}

function getRunner(): RunEnhancedFork {
  const runEnhancedFork = extensionModule.runEnhancedFork as
    | RunEnhancedFork
    | undefined;
  expect(runEnhancedFork).toBeFunction();
  return runEnhancedFork!;
}

async function createSentinel(): Promise<{ path: string; original: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-enhanced-fork-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "session.jsonl");
  const original = '{"type":"session","id":"unchanged"}\n';
  await writeFile(path, original, "utf8");
  return { path, original };
}

describe("runEnhancedFork", () => {
  it("delegates exactly once to ctx.fork and restores compact skill text", async () => {
    const expanded =
      '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>\n\nInvestigate';
    const context = createContext(
      [userEntry("first-id", "First"), userEntry("skill-id", expanded)],
      "skill-id",
    );
    const setEditorText = mock((_text: string) => undefined);
    context.fork = mock(async (_entryId: string, options: unknown) => {
      const withSession = (
        options as {
          withSession: (replacement: {
            ui: { setEditorText(text: string): void };
          }) => Promise<void>;
        }
      ).withSession;
      await withSession({ ui: { setEditorText } });
      return { cancelled: false };
    });

    await getRunner()(context);

    expect(context.ui.custom).toHaveBeenCalledTimes(1);
    expect(context.ui.custom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: {
        anchor: "center",
        margin: 1,
        maxHeight: "80%",
        width: "90%",
      },
    });
    expect(context.fork).toHaveBeenCalledTimes(1);
    expect(context.fork.mock.calls[0]?.[0]).toBe("skill-id");
    expect(context.fork.mock.calls[0]?.[1]).toEqual({
      withSession: expect.any(Function),
    });
    expect(setEditorText).toHaveBeenCalledWith("/skill:diagnose Investigate");
  });

  it("does not delegate when the selector is cancelled", async () => {
    const sentinel = await createSentinel();
    const context = createContext([userEntry("first-id", "First")], undefined);

    await getRunner()(context);

    expect(context.fork).not.toHaveBeenCalled();
    expect(await readFile(sentinel.path, "utf8")).toBe(sentinel.original);
  });

  it("reports fork errors without mutating session files", async () => {
    const sentinel = await createSentinel();
    const context = createContext([userEntry("first-id", "First")], "first-id");
    context.fork = mock(async () => {
      throw new Error("fork failed");
    });

    await getRunner()(context);

    expect(context.fork).toHaveBeenCalledTimes(1);
    expect(context.ui.notify).toHaveBeenCalledWith("fork failed", "error");
    expect(await readFile(sentinel.path, "utf8")).toBe(sentinel.original);
  });

  it("fails closed when UI, idle state, or candidates are unavailable", async () => {
    const noUi = createContext([userEntry("first-id", "First")], "first-id");
    noUi.hasUI = false;
    await getRunner()(noUi);
    expect(noUi.ui.custom).not.toHaveBeenCalled();

    const busy = createContext([userEntry("first-id", "First")], "first-id");
    busy.isIdle = () => false;
    await getRunner()(busy);
    expect(busy.ui.custom).not.toHaveBeenCalled();
    expect(busy.ui.notify).toHaveBeenCalledWith(
      "Wait for the current response to finish before forking",
      "warning",
    );

    const empty = createContext([], undefined);
    await getRunner()(empty);
    expect(empty.ui.custom).not.toHaveBeenCalled();
    expect(empty.ui.notify).toHaveBeenCalledWith(
      "No user messages to fork from",
      "warning",
    );
  });
});

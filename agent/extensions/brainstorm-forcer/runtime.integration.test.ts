import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const VERIFICATION_COMPLETE_EVENT = "subagent:async-complete";
const HARNESS_RUNTIME_ENV = "BRAINSTORM_FORCER_HARNESS_RUNTIME";

function installRuntimeFixtures(
  pi: ExtensionAPI,
  getOwnerSessionId: () => string,
  runId: string,
  asyncDir: string,
): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user question fixture",
    description: "Question fixture for runtime policy coverage.",
    parameters: Type.Any(),
    async execute() {
      return {
        content: [
          {
            type: "text" as const,
            text: "Unexpected question execution.",
          },
        ],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent fixture",
    description: "Subagent fixture for runtime policy coverage.",
    parameters: Type.Any(),
    async execute() {
      return {
        content: [
          {
            type: "text" as const,
            text: "Unexpected subagent execution.",
          },
        ],
        details: {},
      };
    },
  });
  pi.events.on(RPC_REQUEST_EVENT, (raw) => {
    const request = raw as {
      requestId: string;
      method: "ping" | "spawn" | "status";
    };
    const data =
      request.method === "ping"
        ? {
            version: 1,
            methods: ["ping", "spawn", "status"],
            events: {
              replyPrefix: RPC_REPLY_PREFIX,
              asyncComplete: VERIFICATION_COMPLETE_EVENT,
            },
            session: { sessionId: getOwnerSessionId() },
          }
        : request.method === "spawn"
          ? {
              text: "spawned",
              details: { runId, asyncDir },
            }
          : {
              text: "Run is still active.",
              details: { mode: "single", results: [] },
            };
    pi.events.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: true,
      data,
    });
  });
}

function installHarnessStreamCompatibility(session: {
  session: {
    agent: {
      streamFunction: unknown;
    };
  };
}): void {
  Object.defineProperty(session.session.agent, "streamFn", {
    configurable: true,
    get() {
      return this.streamFunction;
    },
    set(value) {
      this.streamFunction = value;
    },
  });
}

if (process.env[HARNESS_RUNTIME_ENV] === "1") {
  describe("brainstorm-forcer runtime policy", () => {
    it("blocks a pending-verification question through the real Pi tool pipeline", async () => {
      const harnessPackage = ["@marcfargas", "pi-test-harness"].join("/");
      const [{ default: brainstormForcer }, harness] = await Promise.all([
        import("./index"),
        import(harnessPackage),
      ]);
      const runId = "runtime-verification-run";
      const scopeDir = await mkdtemp(join(await realpath(tmpdir()), "pi-subagents-runtime-"));
      const asyncDir = join(scopeDir, "async-subagent-runs", runId);
      await mkdir(asyncDir, { recursive: true });

      let ownerSessionId = "";
      let session: Awaited<ReturnType<typeof harness.createTestSession>> | undefined;
      const previousApiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        session = await harness.createTestSession({
          extensionFactories: [
            (pi: ExtensionAPI) => installRuntimeFixtures(pi, () => ownerSessionId, runId, asyncDir),
            (pi: ExtensionAPI) =>
              brainstormForcer(pi, {
                preflight: async (_sessionId, _cwd, agents) =>
                  agents.map((agent) => ({
                    agent,
                    ok: true,
                  })),
              }),
          ],
          mockTools: {
            ask_user_question: "Unexpected question execution.",
          },
          propagateErrors: false,
        });
        installHarnessStreamCompatibility(session);
        ownerSessionId =
          session.session.extensionRunner.createCommandContext().sessionManager.getSessionId() ??
          "";
        await writeFile(join(session.cwd, "evidence.txt"), "The transition gate is centralized.");
        await session.session.prompt("/brainstorm arm Runtime policy");
        await session.session.prompt("/brainstorm phase exploring");

        await session.run(
          harness.when("Exercise pending verification.", [
            harness.calls("read", { path: "evidence.txt" }),
            harness.calls("brainstorm_record_claim", {
              assertion: "The transition gate is centralized.",
              classification: "empirical",
              critical: true,
              verdict: "verified",
              evidenceIds: ["EV-001"],
              contradictoryEvidenceIds: [],
              impact: "Controls all forward transitions.",
              verificationDomain: "local-code",
              architectureImpact: false,
              mitigation: "Keep one shared blocker.",
            }),
            harness.calls("brainstorm_run_verification", {
              claimIds: ["CL-001"],
            }),
            harness.calls("ask_user_question", { questions: [] }),
            harness.says("Question deferred until verification ends."),
          ]),
        );

        const calls = session.events.toolCallsFor("ask_user_question");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          blocked: true,
          input: { questions: [] },
        });
        expect(calls[0]?.blockReason).toContain(
          "ask_user_question is blocked while verification run runtime-verification-run is pending",
        );

        const results = session.events.toolResultsFor("ask_user_question");
        expect(results).toHaveLength(1);
        expect(results[0]?.isError).toBe(true);
        expect(results[0]?.text).toContain(
          "ask_user_question is blocked while verification run runtime-verification-run is pending",
        );

        const wrappedQuestionTool = session.session.agent.state.tools.find(
          (tool: { name: string }) => tool.name === "ask_user_question",
        );
        expect(wrappedQuestionTool).toBeDefined();
        await expect(
          wrappedQuestionTool.execute(
            "direct-runtime-block",
            { questions: [] },
            new AbortController().signal,
            undefined,
          ),
        ).rejects.toBeInstanceOf(harness.ToolBlockedError);

        const branchPoint = session.session.sessionManager
          .getEntries()
          .find(
            (entry: any) =>
              entry.type === "custom" &&
              entry.customType === "brainstorm-forcer-ledger" &&
              entry.data?.record?.id === "CL-001",
          );
        expect(branchPoint).toBeDefined();
        const abandonedLeafId = session.session.sessionManager.getLeafId();
        const navigation = await session.session.navigateTree(branchPoint.id, {
          summarize: false,
        });
        expect(navigation.cancelled).toBe(false);
        expect(session.session.sessionManager.getLeafId()).toBe(branchPoint.id);
        expect(
          session.session.sessionManager
            .getBranch()
            .some(
              (entry: any) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer" &&
                entry.data?.pendingVerification?.runId === runId,
            ),
        ).toBe(false);
        expect(abandonedLeafId).not.toBe(branchPoint.id);
        const restoredContext =
          await session.session.extensionRunner.emitContext([]);
        expect(restoredContext.at(-1)?.content).toContain(
          "Verification: none pending",
        );
      } finally {
        session?.dispose();
        if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousApiKey;
        await rm(scopeDir, { recursive: true, force: true });
      }
    });

    it("restarts a corrupted branch from a persisted temporary JSONL session", async () => {
      const [{ default: brainstormForcer }, codingAgent, { getModel }] =
        await Promise.all([
          import("./index"),
          import("@earendil-works/pi-coding-agent"),
          import("@earendil-works/pi-ai/compat"),
        ]);
      const root = await mkdtemp(
        join(await realpath(tmpdir()), "pi-subagents-jsonl-runtime-"),
      );
      const cwd = join(root, "project");
      const sessionDir = join(root, "sessions");
      const runId = "runtime-jsonl-verification-run";
      const asyncDir = join(root, "async-subagent-runs", runId);
      await Promise.all([
        mkdir(cwd, { recursive: true }),
        mkdir(asyncDir, { recursive: true }),
      ]);
      const model = getModel("openai", "gpt-4o");
      const initialManager = codingAgent.SessionManager.create(cwd, sessionDir);
      initialManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Runtime restart fixture." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const createRuntime = async (
        sessionManager: ReturnType<typeof codingAgent.SessionManager.open>,
        extensionFactories: Array<(pi: ExtensionAPI) => void>,
      ) => {
        const settingsManager = codingAgent.SettingsManager.inMemory();
        const loader = new codingAgent.DefaultResourceLoader({
          cwd,
          agentDir: cwd,
          settingsManager,
          extensionFactories,
        });
        await loader.reload();
        const result = await codingAgent.createAgentSession({
          cwd,
          agentDir: cwd,
          model,
          sessionManager,
          settingsManager,
          resourceLoader: loader,
        });
        expect(result.extensionsResult.errors).toHaveLength(0);
        const errors: unknown[] = [];
        await result.session.bindExtensions({
          onError: (error) => errors.push(error),
        });
        return { session: result.session, errors };
      };

      const ownerSessionId = initialManager.getSessionId();
      const first = await createRuntime(initialManager, [
        (pi) =>
          installRuntimeFixtures(
            pi,
            () => ownerSessionId,
            runId,
            asyncDir,
          ),
        (pi) =>
          brainstormForcer(pi, {
            preflight: async (_sessionId, _cwd, agents) =>
              agents.map((agent) => ({ agent, ok: true })),
          }),
      ]);
      try {
        await first.session.prompt("/brainstorm arm Runtime JSONL restart");
        await first.session.prompt("/brainstorm phase exploring");
        await writeFile(
          join(cwd, "evidence.txt"),
          "The branch transition is observable.",
        );
        const execute = async (
          name: string,
          toolCallId: string,
          input: Record<string, unknown>,
        ) => {
          const tool = first.session.agent.state.tools.find(
            (candidate: { name: string }) => candidate.name === name,
          );
          if (!tool) throw new Error(`Runtime tool not found: ${name}.`);
          return tool.execute(
            toolCallId,
            input,
            new AbortController().signal,
            undefined,
          );
        };
        const readResult = await execute("read", "runtime-read", {
          path: "evidence.txt",
        });
        await first.session.extensionRunner.emitToolResult({
          type: "tool_result",
          toolCallId: "runtime-read",
          toolName: "read",
          input: { path: "evidence.txt" },
          content: readResult.content,
          details: readResult.details,
          isError: false,
        });
        for (let index = 1; index <= 5; index += 1) {
          await execute("brainstorm_record_claim", `runtime-claim-${index}`, {
            assertion: `Runtime branch claim ${index}.`,
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: ["EV-001"],
            contradictoryEvidenceIds: [],
            impact: `Controls runtime branch behavior ${index}.`,
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep runtime branch state isolated.",
          });
        }
        const branchPoint = initialManager
          .getBranch()
          .find(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "brainstorm-forcer-ledger" &&
              (entry.data as any).record?.id === "CL-003",
          );
        expect(branchPoint).toBeDefined();
        await execute("brainstorm_run_verification", "runtime-verification", {
          claimIds: ["CL-004", "CL-005"],
        });
        const staleSnapshot = structuredClone(
          (
            initialManager
              .getBranch()
              .findLast(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "brainstorm-forcer",
              ) as any
          ).data,
        );
        initialManager.branch(branchPoint!.id);
        initialManager.appendCustomEntry("brainstorm-forcer", staleSnapshot);
        const sessionFile = initialManager.getSessionFile();
        expect(sessionFile).toBeDefined();
        expect(await readFile(sessionFile!, "utf8")).toContain(
          '"runId":"runtime-jsonl-verification-run"',
        );

        const reopened = codingAgent.SessionManager.open(
          sessionFile!,
          sessionDir,
          cwd,
        );
        expect(
          reopened
            .getBranch()
            .some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer-ledger" &&
                ["CL-004", "CL-005"].includes(
                  (entry.data as any).record?.id,
                ),
            ),
        ).toBe(false);
        const second = await createRuntime(reopened, [
          (pi) => brainstormForcer(pi, { rpcTimeoutMs: 20 }),
        ]);
        try {
          expect(second.errors).toHaveLength(0);
          expect(reopened.getBranch().at(-1)).toMatchObject({
            type: "custom",
            customType: "brainstorm-forcer",
            data: { pendingVerification: null },
          });
          expect(
            reopened
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "brainstorm-forcer-ledger" &&
                  (entry.data as any).record?.kind === "review",
              ),
          ).toBe(false);
          const context =
            await second.session.extensionRunner.emitContext([]);
          const statusMessage = context.findLast(
            (
              message,
            ): message is Extract<
              (typeof context)[number],
              { role: "custom" }
            > =>
              message.role === "custom" &&
              message.customType === "brainstorm-forcer-status",
          );
          expect(statusMessage?.content).toContain(
            "Verification: none pending",
          );
        } finally {
          second.session.dispose();
        }

        const verified = codingAgent.SessionManager.open(
          sessionFile!,
          sessionDir,
          cwd,
        );
        expect(verified.getBranch().at(-1)).toMatchObject({
          type: "custom",
          customType: "brainstorm-forcer",
          data: { pendingVerification: null },
        });
      } finally {
        first.session.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
} else {
  describe("brainstorm-forcer runtime policy", () => {
    it("runs the real Pi pipeline with the harness compatibility preload", async () => {
      const extensionDir = dirname(fileURLToPath(import.meta.url));
      const agentDir = join(extensionDir, "..", "..");
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--preload",
          join(extensionDir, "runtime-harness.preload.ts"),
          "--isolate",
          fileURLToPath(import.meta.url),
        ],
        {
          cwd: agentDir,
          env: {
            ...process.env,
            [HARNESS_RUNTIME_ENV]: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}${stderr}`;
      if (exitCode !== 0)
        throw new Error(`Nested pi-test-harness runtime failed (${exitCode}).\n${output}`);

      expect(output).toContain("2 pass");
      expect(output).toContain("0 fail");
    });
  });
}

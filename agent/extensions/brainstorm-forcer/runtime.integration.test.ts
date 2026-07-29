import { describe, expect, it } from "bun:test";
import type {
  ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
  chmod,
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

async function createBoundRuntime(
  codingAgent: typeof import("@earendil-works/pi-coding-agent"),
  model: any,
  cwd: string,
  sessionManager: SessionManager,
  extensionFactories: Array<(pi: ExtensionAPI) => void>,
  additionalExtensionPaths: string[] = [],
) {
  const settingsManager = codingAgent.SettingsManager.inMemory();
  const loader = new codingAgent.DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    extensionFactories,
    additionalExtensionPaths,
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
}

async function waitForRuntime(
  predicate: () => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

function persistRuntimeSession(
  sessionManager: SessionManager,
  model: any,
): void {
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Runtime session fixture." }],
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
}

async function executeRuntimeTool(
  session: any,
  name: string,
  toolCallId: string,
  input: Record<string, unknown>,
) {
  const tool = session.agent.state.tools.find(
    (candidate: { name: string }) => candidate.name === name,
  );
  if (!tool) throw new Error(`Runtime tool not found: ${name}.`);
  return tool.execute(
    toolCallId,
    input,
    new AbortController().signal,
    undefined,
  );
}

async function launchRuntimeVerification(session: any, cwd: string) {
  await session.prompt("/brainstorm arm Runtime package contract");
  await session.prompt("/brainstorm phase exploring");
  await writeFile(
    join(cwd, "evidence.txt"),
    "The transition gate is centralized.",
  );
  const readResult = await executeRuntimeTool(
    session,
    "read",
    "runtime-contract-read",
    { path: "evidence.txt" },
  );
  await session.extensionRunner.emitToolResult({
    type: "tool_result",
    toolCallId: "runtime-contract-read",
    toolName: "read",
    input: { path: "evidence.txt" },
    content: readResult.content,
    details: readResult.details,
    isError: false,
  });
  await executeRuntimeTool(
    session,
    "brainstorm_record_claim",
    "runtime-contract-claim",
    {
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
    },
  );
  return executeRuntimeTool(
    session,
    "brainstorm_run_verification",
    "runtime-contract-verification",
    { claimIds: ["CL-001"] },
  );
}

async function installStructuredMockPi(
  harness: typeof import("@marcfargas/pi-test-harness"),
  root: string,
  structuredOutput: unknown,
  delay = 0,
) {
  const mockPi = harness.createMockPi();
  mockPi.install();
  mockPi.onCall({ output: "Structured output captured.", delay });
  const scriptPath = join(root, "structured-mock-pi.mjs");
  const launcherPath = join(
    root,
    process.platform === "win32" ? "structured-mock-pi.cmd" : "structured-mock-pi",
  );
  await writeFile(
    scriptPath,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const capture = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;',
      'const value = process.env.BRAINSTORM_TEST_STRUCTURED_OUTPUT;',
      'if (capture && value) writeFileSync(capture, value);',
      'const child = spawn(process.env.BRAINSTORM_MOCK_PI_BINARY, process.argv.slice(2), { env: process.env, stdio: "inherit" });',
      'child.on("exit", (code) => process.exit(code ?? 1));',
    ].join("\n"),
  );
  if (process.platform === "win32") {
    await writeFile(
      launcherPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
  } else {
    await writeFile(
      launcherPath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    );
    await chmod(launcherPath, 0o755);
  }

  const previous = {
    binary: process.env.PI_SUBAGENT_PI_BINARY,
    mockBinary: process.env.BRAINSTORM_MOCK_PI_BINARY,
    structuredOutput: process.env.BRAINSTORM_TEST_STRUCTURED_OUTPUT,
  };
  process.env.PI_SUBAGENT_PI_BINARY = launcherPath;
  process.env.BRAINSTORM_MOCK_PI_BINARY = join(
    mockPi.dir,
    process.platform === "win32" ? "pi.cmd" : "pi",
  );
  process.env.BRAINSTORM_TEST_STRUCTURED_OUTPUT =
    JSON.stringify(structuredOutput);

  return {
    mockPi,
    cleanup() {
      if (previous.binary === undefined)
        delete process.env.PI_SUBAGENT_PI_BINARY;
      else process.env.PI_SUBAGENT_PI_BINARY = previous.binary;
      if (previous.mockBinary === undefined)
        delete process.env.BRAINSTORM_MOCK_PI_BINARY;
      else process.env.BRAINSTORM_MOCK_PI_BINARY = previous.mockBinary;
      if (previous.structuredOutput === undefined)
        delete process.env.BRAINSTORM_TEST_STRUCTURED_OUTPUT;
      else
        process.env.BRAINSTORM_TEST_STRUCTURED_OUTPUT =
          previous.structuredOutput;
      mockPi.uninstall();
    },
  };
}

function installRuntimeFixtures(
  pi: ExtensionAPI,
  getOwnerSession: () => { sessionId: string; sessionFile: string },
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
            session: getOwnerSession(),
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

      let ownerSession = { sessionId: "", sessionFile: "" };
      let session: Awaited<ReturnType<typeof harness.createTestSession>> | undefined;
      const previousApiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        session = await harness.createTestSession({
          extensionFactories: [
            (pi: ExtensionAPI) =>
              installRuntimeFixtures(pi, () => ownerSession, runId, asyncDir),
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
        const sessionManager =
          session.session.extensionRunner.createCommandContext().sessionManager;
        const sessionFile = join(session.cwd, "runtime-session.jsonl");
        Object.defineProperty(sessionManager, "getSessionFile", {
          configurable: true,
          value: () => sessionFile,
        });
        ownerSession = {
          sessionId: sessionManager.getSessionId() ?? "",
          sessionFile,
        };
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
      persistRuntimeSession(initialManager, model);
      const ownerSessionId = initialManager.getSessionId();
      const ownerSessionFile = initialManager.getSessionFile()!;
      const first = await createBoundRuntime(
        codingAgent,
        model,
        cwd,
        initialManager,
        [
        (pi) =>
          installRuntimeFixtures(
            pi,
            () => ({
              sessionId: ownerSessionId,
              sessionFile: ownerSessionFile,
            }),
            runId,
            asyncDir,
          ),
        (pi) =>
          brainstormForcer(pi, {
            preflight: async (_sessionId, _cwd, agents) =>
              agents.map((agent) => ({ agent, ok: true })),
          }),
        ],
      );
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
        const second = await createBoundRuntime(
          codingAgent,
          model,
          cwd,
          reopened,
          [(pi) => brainstormForcer(pi, { rpcTimeoutMs: 20 })],
        );
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

    it("accepts real package completion and audits an exact public stop as failed", async () => {
      const harnessPackage = ["@marcfargas", "pi-test-harness"].join("/");
      const [
        { default: brainstormForcer },
        codingAgent,
        { getModel },
        harness,
      ] = await Promise.all([
        import("./index"),
        import("@earendil-works/pi-coding-agent"),
        import("@earendil-works/pi-ai/compat"),
        import(harnessPackage),
      ]);
      const root = await mkdtemp(
        join(await realpath(tmpdir()), "brainstorm-package-runtime-"),
      );
      const cwd = join(root, "project");
      const sessionDir = join(root, "sessions");
      await Promise.all([
        mkdir(cwd, { recursive: true }),
        mkdir(sessionDir, { recursive: true }),
      ]);
      const model = getModel("openai", "gpt-4o");
      const sessionManager = codingAgent.SessionManager.create(cwd, sessionDir);
      persistRuntimeSession(sessionManager, model);
      const structuredOutput = {
        outcome: "supported",
        claimIds: ["CL-001"],
        evidenceIds: ["EV-001"],
        summary: "The exact package contract supports the claim.",
      };
      const child = await installStructuredMockPi(
        harness,
        root,
        structuredOutput,
      );
      const completions: unknown[] = [];
      const runtime = await createBoundRuntime(
        codingAgent,
        model,
        cwd,
        sessionManager,
        [
          (pi) => {
            pi.events.on(VERIFICATION_COMPLETE_EVENT, (event) => {
              completions.push(event);
            });
          },
          (pi) =>
            brainstormForcer(pi, {
              preflight: async (_sessionId, _cwd, agents) =>
                agents.map((agent) => ({ agent, ok: true })),
            }),
        ],
        [fileURLToPath(import.meta.resolve("pi-subagents"))],
      );
      const asyncDirs: string[] = [];
      const resultPaths: string[] = [];
      try {
        const launch = await launchRuntimeVerification(runtime.session, cwd);
        expect(launch.details).toMatchObject({ status: "pending" });
        const naturalRunId = (launch.details as { runId: string }).runId;
        const pending = (
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ) as any
        ).data.pendingVerification;
        asyncDirs.push(pending.asyncDir);
        expect(pending).toMatchObject({
          runId: naturalRunId,
          ownerSessionId: sessionManager.getSessionId(),
          ownerSessionFile: sessionManager.getSessionFile(),
        });
        const naturalResultPath = join(
          dirname(dirname(pending.asyncDir)),
          "async-subagent-results",
          `${naturalRunId}.json`,
        );
        resultPaths.push(naturalResultPath);
        await waitForRuntime(
          () => existsSync(naturalResultPath),
          "Natural pi-subagents result artifact was not written.",
        );
        // Bun's nested harness can miss the native fs.watch edge. Replaying the
        // public reload lifecycle primes the installed package's real watcher.
        await runtime.session.extensionRunner.emit({
          type: "session_start",
          reason: "reload",
        });

        try {
          await waitForRuntime(
            () =>
              completions.length >= 1 &&
              sessionManager
                .getEntries()
                .some(
                  (entry) =>
                    entry.type === "custom" &&
                    entry.customType === "brainstorm-forcer-ledger" &&
                    (entry.data as any).record?.kind === "review" &&
                    (entry.data as any).record?.audit?.verificationRunId ===
                      naturalRunId,
                ),
            "Natural pi-subagents completion was not audited.",
          );
        } catch (error) {
          const [status, result] = await Promise.all([
            readFile(join(pending.asyncDir, "status.json"), "utf8").catch(
              (readError) => String(readError),
            ),
            readFile(naturalResultPath, "utf8").catch((readError) =>
              String(readError),
            ),
          ]);
          throw new Error(
            [
              error instanceof Error ? error.message : String(error),
              `mock calls: ${child.mockPi.callCount()}`,
              `completions: ${JSON.stringify(completions)}`,
              `runtime errors: ${runtime.errors.map(String).join(" | ")}`,
              `status: ${status}`,
              `result: ${result}`,
            ].join("\n"),
          );
        }
        const naturalCompletion = completions.find(
          (event: any) => event?.runId === naturalRunId,
        ) as any;
        expect(naturalCompletion).toMatchObject({
          runId: naturalRunId,
          sessionId: sessionManager.getSessionFile(),
          state: "complete",
          exitCode: 0,
        });
        expect(
          Object.hasOwn(naturalCompletion.results[0], "exitCode"),
        ).toBe(false);
        const naturalReview = sessionManager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "brainstorm-forcer-ledger" &&
              (entry.data as any).record?.kind === "review" &&
              (entry.data as any).record?.audit?.verificationRunId ===
                naturalRunId,
          ) as any;
        expect(naturalReview.data.record.audit).toMatchObject({
          status: "success",
          verificationRunId: naturalRunId,
        });

        child.mockPi.reset();
        child.mockPi.onCall({ output: "Stopped before completion.", delay: 10_000 });
        await executeRuntimeTool(
          runtime.session,
          "brainstorm_record_claim",
          "runtime-contract-second-claim",
          {
            assertion: "The stop path preserves ownership.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: ["EV-001"],
            contradictoryEvidenceIds: [],
            impact: "Controls stop audit classification.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Require exact owner correlation.",
          },
        );
        const stoppedLaunch = await executeRuntimeTool(
          runtime.session,
          "brainstorm_run_verification",
          "runtime-contract-stopped-verification",
          { claimIds: ["CL-002"] },
        );
        const stoppedRunId = (stoppedLaunch.details as { runId: string }).runId;
        const stoppedPending = (
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ) as any
        ).data.pendingVerification;
        asyncDirs.push(stoppedPending.asyncDir);
        const stoppedResultPath = join(
          dirname(dirname(stoppedPending.asyncDir)),
          "async-subagent-results",
          `${stoppedRunId}.json`,
        );
        resultPaths.push(stoppedResultPath);
        await waitForRuntime(
          () => child.mockPi.callCount() === 1,
          "Stopped pi-subagents child did not start.",
        );
        const stop = await executeRuntimeTool(
          runtime.session,
          "subagent",
          "runtime-contract-stop",
          { action: "stop", id: stoppedRunId },
        );
        expect(stop.isError).not.toBe(true);
        await waitForRuntime(
          () => existsSync(stoppedResultPath),
          "Stopped pi-subagents result artifact was not written.",
        );
        await runtime.session.extensionRunner.emit({
          type: "session_start",
          reason: "reload",
        });
        await waitForRuntime(
          () =>
            completions.some(
              (event: any) =>
                event?.runId === stoppedRunId && event?.state === "stopped",
            ) &&
            sessionManager
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "brainstorm-forcer-ledger" &&
                  (entry.data as any).record?.kind === "review" &&
                  (entry.data as any).record?.audit?.verificationRunId ===
                    stoppedRunId,
              ),
          "Stopped pi-subagents completion was not audited.",
        );
        const stoppedCompletion = completions.find(
          (event: any) => event?.runId === stoppedRunId,
        ) as any;
        expect(stoppedCompletion).toMatchObject({
          sessionId: sessionManager.getSessionFile(),
          state: "stopped",
        });
        expect(
          Object.hasOwn(stoppedCompletion.results[0], "exitCode"),
        ).toBe(false);
        const stoppedReview = sessionManager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "brainstorm-forcer-ledger" &&
              (entry.data as any).record?.kind === "review" &&
              (entry.data as any).record?.audit?.verificationRunId ===
                stoppedRunId,
          ) as any;
        expect(stoppedReview.data.record.audit).toMatchObject({
          status: "failed",
          verificationRunId: stoppedRunId,
          reason: "Subagent stopped by user.",
        });
        expect(
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ),
        ).toMatchObject({
          data: { pendingVerification: null },
        });
        expect(runtime.errors).toHaveLength(0);
      } finally {
        runtime.session.dispose();
        child.cleanup();
        await Promise.all(
          [
            ...asyncDirs.map((asyncDir) =>
              rm(asyncDir, { recursive: true, force: true }),
            ),
            ...resultPaths.map((resultPath) => rm(resultPath, { force: true })),
          ],
        );
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
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

      expect(output).toContain("3 pass");
      expect(output).toContain("0 fail");
    }, 35_000);
  });
}

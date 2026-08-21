/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type {
  ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
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

const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";
const HARNESS_RUNTIME_ENV = "BRAINSTORM_FORCER_HARNESS_RUNTIME";

async function createBoundRuntime(
  codingAgent: typeof import("@earendil-works/pi-coding-agent"),
  model: any,
  cwd: string,
  sessionManager: SessionManager,
  extensionFactories: Array<(pi: ExtensionAPI) => void>,
  additionalExtensionPaths: string[] = [],
) {
  const settingsManager = codingAgent.SettingsManager.inMemory({
    subagents: {
      agentOverrides: {
        "brainstorm-code-scout": { model: "brainstorm-test/mock" },
      },
    },
  } as any);
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
  harness: typeof import("@abdwhb-png/pi-test-harness"),
  root: string,
  structuredOutput: unknown,
  delay = 0,
) {
  const mockPi = harness.createMockPi();
  mockPi.install();
  mockPi.onCall({
    delay,
    jsonl: [
      {
        type: "tool_execution_start",
        toolCallId: "structured-output-1",
        toolName: "structured_output",
        args: structuredOutput,
      },
      {
        type: "tool_execution_end",
        toolCallId: "structured-output-1",
        toolName: "structured_output",
        result: { content: [{ type: "text", text: "captured" }] },
        isError: false,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "structured-output-1",
              name: "structured_output",
              arguments: structuredOutput,
            },
          ],
          stopReason: "toolUse",
          model: "mock/test-model",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.001 },
          },
        },
      },
    ],
  });
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

function installRuntimeFixtures(pi: ExtensionAPI): void {
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
  pi.events.on(DELEGATION_REQUEST_EVENT, () => undefined);
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
      const harnessPackage = ["@abdwhb-png", "pi-test-harness"].join("/");
      const [{ default: brainstormForcer }, harness] = await Promise.all([
        import("./index"),
        import(harnessPackage),
      ]);
      let session: Awaited<ReturnType<typeof harness.createTestSession>> | undefined;
      const previousApiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        session = await harness.createTestSession({
          extensionFactories: [
            (pi: ExtensionAPI) => installRuntimeFixtures(pi),
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
        expect(calls[0]?.blockReason).toMatch(
          /ask_user_question is blocked while verification run verification-[\w-]+ is pending/,
        );

        const results = session.events.toolResultsFor("ask_user_question");
        expect(results).toHaveLength(1);
        expect(results[0]?.isError).toBe(true);
        expect(results[0]?.text).toMatch(
          /ask_user_question is blocked while verification run verification-[\w-]+ is pending/,
        );

        const wrappedQuestionTool = session.session.agent.state.tools.find(
          (tool: { name: string }) => tool.name === "ask_user_question",
        );
        expect(wrappedQuestionTool).toBeDefined();

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
                entry.data?.pendingVerification !== null,
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
      }
    }, 30_000);

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
      await Promise.all([
        mkdir(cwd, { recursive: true }),
      ]);
      const model = getModel("openai", "gpt-4o");
      const initialManager = codingAgent.SessionManager.create(cwd, sessionDir);
      persistRuntimeSession(initialManager, model);
      const first = await createBoundRuntime(
        codingAgent,
        model,
        cwd,
        initialManager,
        [
        (pi) => installRuntimeFixtures(pi),
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
          `"runId":"${staleSnapshot.pendingVerification.runId}"`,
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
          [(pi) => brainstormForcer(pi)],
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
    }, 15_000);

    it("uses the real structured delegation boundary and exact cancellation", async () => {
      const harnessPackage = ["@abdwhb-png", "pi-test-harness"].join("/");
      const root = await mkdtemp(
        join(await realpath(tmpdir()), "brainstorm-structured-runtime-"),
      );
      const cwd = join(root, "project");
      const sessionDir = join(root, "sessions");
      const isolatedAgentDir = join(root, "agent");
      await Promise.all([
        mkdir(cwd, { recursive: true }),
        mkdir(sessionDir, { recursive: true }),
        mkdir(isolatedAgentDir, { recursive: true }),
      ]);
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
      const [
        { default: brainstormForcer },
        codingAgent,
        { getModel },
        harness,
        { default: subagentsExtension },
      ] = await Promise.all([
        import("./index"),
        import("@earendil-works/pi-coding-agent"),
        import("@earendil-works/pi-ai/compat"),
        import(harnessPackage),
        import("pi-subagents"),
      ]);
      await writeFile(
        join(isolatedAgentDir, "settings.json"),
        JSON.stringify({
          subagents: {
            agentOverrides: { "brainstorm-code-scout": { model: "brainstorm-test/mock" } },
          },
        }),
      );
      await mkdir(join(isolatedAgentDir, "agents"), { recursive: true });
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "code-analysis.scout.md"),
        "---\nname: scout\npackage: code-analysis\ndescription: Colliding project scout\ntools: '@inspect'\n---\n",
      );
      const model = getModel("openai", "gpt-4o");
      const sessionManager = codingAgent.SessionManager.create(cwd, sessionDir);
      persistRuntimeSession(sessionManager, model);
      const child = await installStructuredMockPi(harness, root, {
        outcome: "supported",
        claimIds: ["CL-001"],
        evidenceIds: ["EV-001"],
        summary: "The exact package contract supports the claim.",
      });
      const requests: Array<Record<string, unknown>> = [];
      const responses: Array<Record<string, unknown>> = [];
      const cancellations: Array<Record<string, unknown>> = [];
      const runtime = await createBoundRuntime(
        codingAgent,
        model,
        cwd,
        sessionManager,
        [
          (pi) =>
            pi.registerProvider("brainstorm-test", {
              baseUrl: "http://127.0.0.1:1",
              apiKey: "test-key",
              api: "openai-responses",
              models: [
                {
                  id: "mock",
                  name: "Brainstorm runtime mock",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 16_384,
                  maxTokens: 2_048,
                },
              ],
            }),
          (pi) =>
            subagentsExtension(
              pi as unknown as Parameters<typeof subagentsExtension>[0],
            ),
          (pi) => {
            pi.events.on(DELEGATION_REQUEST_EVENT, (event) =>
              requests.push(event as Record<string, unknown>),
            );
            pi.events.on(DELEGATION_RESPONSE_EVENT, (event) =>
              responses.push(event as Record<string, unknown>),
            );
            pi.events.on(DELEGATION_CANCEL_EVENT, (event) =>
              cancellations.push(event as Record<string, unknown>),
            );
          },
          (pi) =>
            brainstormForcer(pi, {
              preflight: async (_sessionId, _cwd, agents) =>
                agents.map((agent) => ({ agent, ok: true })),
            }),
        ],
      );
      try {
        const launch = await launchRuntimeVerification(runtime.session, cwd);
        const naturalRunId = (launch.details as { runId: string }).runId;
        await waitForRuntime(
          () =>
            responses.length === 1 &&
            sessionManager.getEntries().some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer-ledger" &&
                (entry.data as any).record?.audit?.verificationRunId ===
                  naturalRunId,
            ),
          "Structured delegation completion was not audited.",
        );
        expect(requests[0]).toMatchObject({
          ownerRunId: naturalRunId,
          nodeId: "verify_local_code_supported",
          agent: "brainstorm-code-scout",
          context: "fresh",
          result: { kind: "structured" },
        });
        expect(requests[0]).not.toHaveProperty("chain");
        expect(responses[0]).toMatchObject({
          requestId: requests[0]!.requestId,
          ownerRunId: naturalRunId,
          nodeId: requests[0]!.nodeId,
          status: "completed",
          result: { kind: "structured" },
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
            impact: "Controls stop ownership.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Cancel the exact attempt tuple.",
          },
        );
        const stoppedLaunch = await executeRuntimeTool(
          runtime.session,
          "brainstorm_run_verification",
          "runtime-contract-stopped-verification",
          { claimIds: ["CL-002"] },
        );
        const stoppedRunId = (stoppedLaunch.details as { runId: string }).runId;
        await waitForRuntime(
          () => requests.length === 2,
          "Second structured delegation attempt did not start.",
        );
        await runtime.session.prompt("/brainstorm stop");
        await waitForRuntime(
          () => cancellations.length === 1,
          "Exact structured delegation cancellation was not emitted.",
        );
        expect(cancellations[0]).toEqual({
          requestId: requests[1]!.requestId,
          ownerRunId: stoppedRunId,
          nodeId: requests[1]!.nodeId,
        });
        expect(runtime.errors).toHaveLength(0);
      } finally {
        runtime.session.dispose();
        child.cleanup();
        if (previousAgentDir === undefined)
          delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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

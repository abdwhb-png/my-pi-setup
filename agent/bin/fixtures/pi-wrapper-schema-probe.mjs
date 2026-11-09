import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

const { createDefaultChildSessionFactory } = await import(pathToFileURL(process.env.PI_WRAPPER_CHILD_FACTORY).href);

export default async function (TodoParamsSchema) {
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkAttempts++;
    throw new Error("Network access is forbidden in the schema contract");
  };
  const factory = createDefaultChildSessionFactory();
  let child;
  let childSchema;
  let started = 0;
  let stopped = 0;
  const errors = [];
  try {
    child = await factory.create({
      cwd: process.cwd(), storage: { kind: "memory" }, tools: ["todo"],
      extensionPaths: [process.env.PI_WRAPPER_TODO_ENTRY], ambientExtensions: false,
      noSkills: true, noContextFiles: true, runtime: {},
      hooks: [{ name: "schema-contract", factory(pi) {
        pi.on("session_start", () => {
          started++;
          childSchema = pi.getAllTools().find(tool => tool.name === "todo")?.parameters;
        });
        pi.on("session_shutdown", () => { stopped++; });
      } }],
      onExtensionError: error => errors.push(error),
    });
    assert(childSchema, "The real child must register the installed todo tool");
    const payloads = await Promise.all([TodoParamsSchema, childSchema].map(async parameters => {
      let calls = 0;
      let payload;
      const result = await stream({
        id: "schema-fixture", name: "Schema fixture", provider: "cpa",
        api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
        reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStrictMode: false },
      }, normalizeContext({
        messages: [{ role: "user", content: "Schema contract", timestamp: 0 }],
        tools: [{ name: "todo", description: "Schema contract", parameters }],
      }), {
        apiKey: "fixture-only",
        fetch: async (_url, init) => {
          calls++;
          payload = JSON.parse(init.body).tools[0].function.parameters;
          return new Response(
            'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
            'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(calls, 1);
      return payload;
    }));
    await child.dispose();
    child = undefined;
    assert.deepEqual(errors, []);
    assert.deepEqual([started, stopped], [1, 1]);
    assert.equal(networkAttempts, 0);
    writeFileSync(process.env.PI_WRAPPER_SCHEMA_OUTPUT, JSON.stringify({ payloads, started, stopped, networkAttempts, bun: process.versions.bun }));
  } finally {
    try {
      if (child) await child.dispose();
      await factory.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  process.exit(0);
}

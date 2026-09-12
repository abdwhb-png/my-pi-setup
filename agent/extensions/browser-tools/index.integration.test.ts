import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createTestSession,
  type TestSession,
} from "@abdwhb-png/pi-test-harness";

const AGENT_ROOT = resolve(import.meta.dir, "../..");
const BROWSER_TOOLS_EXTENSION = resolve(import.meta.dir, "index.ts");
const NATIVE_BROWSER_EXTENSION = resolve(
  homedir(),
  "projects/pi-integrations/pi-agent-browser-native/dist/extensions/agent-browser/index.js",
);
const TOOL_GROUPS_EXTENSION = resolve(import.meta.dir, "../tool-groups/index.ts");

let session: TestSession | undefined;

afterEach(() => {
  session?.dispose();
  session = undefined;
});

test.skipIf(!process.env.PI_BROWSER_TOOLS_RUNTIME_CONTRACT)(
  "manual Agent Browser activation is visible and executable through the Pi runtime",
  async () => {
    session = await createTestSession({
      cwd: AGENT_ROOT,
      extensions: [TOOL_GROUPS_EXTENSION, NATIVE_BROWSER_EXTENSION, BROWSER_TOOLS_EXTENSION],
      propagateErrors: false,
    });

    expect(session.session.getActiveToolNames()).not.toContain("agent_browser");

    await session.session.prompt("/browser-tools on");
    expect(session.session.getActiveToolNames()).toContain("agent_browser");
    expect(
      session.session.agent.state.tools.filter(
        (candidate) => candidate.name === "agent_browser",
      ),
    ).toHaveLength(1);
    const tool = session.session.agent.state.tools.find(
      (candidate) => candidate.name === "agent_browser",
    );
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      "browser-tools-runtime-contract",
      { args: ["--version"] },
      undefined,
      () => {},
    );
    expect(
      result.content.some(
        (item) => item.type === "text" && /agent-browser \d+\.\d+\.\d+/.test(item.text),
      ),
    ).toBe(true);

    await session.session.prompt("/browser-tools off");
    expect(session.session.getActiveToolNames()).not.toContain("agent_browser");
  },
  30_000,
);

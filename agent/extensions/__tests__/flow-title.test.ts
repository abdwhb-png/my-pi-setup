import { expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import flowTitle from "../flow-title.ts";

type SessionStartHandler = (
  event: SessionStartEvent,
  ctx: ExtensionContext,
) => unknown;
type HeaderFactory = Exclude<
  Parameters<ExtensionUIContext["setHeader"]>[0],
  undefined
>;

test("flow title keeps complex model-name graphemes intact", () => {
  let sessionStart: SessionStartHandler | undefined;
  let headerFactory: HeaderFactory | undefined;
  const pi = {
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;

  flowTitle(pi);

  const ui = {
    setHeader(factory: HeaderFactory | undefined) {
      if (factory) headerFactory = factory;
    },
  } as unknown as ExtensionUIContext;
  sessionStart?.(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      model: { id: "family-👨‍👩‍👧‍👦" },
      ui,
    } as unknown as ExtensionContext,
  );

  expect(headerFactory).toBeDefined();
  const component = headerFactory!(
    { requestRender() {} } as unknown as TUI,
    {} as Theme,
  );
  expect(component.render(80).join("\n")).toContain("👨‍👩‍👧‍👦");
});

import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { appendCompressionFooter } from "../_shared/compression-render";

function renderTextResultWithCompression(
  component: Text,
  details: object | undefined,
  theme: Theme,
  isPartial: boolean,
): Component {
  if (!isPartial) {
    const container = new Container();
    container.addChild(component);
    appendCompressionFooter(container, details, theme);
    if (container.children.length > 1) return container;
  }
  return component;
}

export default function piOverrides(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const readDef = createReadToolDefinition(ctx.cwd);
    const grepDef = createGrepToolDefinition(ctx.cwd);
    const lsDef = createLsToolDefinition(ctx.cwd);
    const findDef = createFindToolDefinition(ctx.cwd);
    const readTextByCallId = new Map<string, Text>();
    const grepTextByCallId = new Map<string, Text>();
    const lsTextByCallId = new Map<string, Text>();
    const findTextByCallId = new Map<string, Text>();

    pi.registerTool({
      ...readDef,
      renderResult: (result, options, theme, context) => {
        let text = readTextByCallId.get(context.toolCallId);
        if (!text) {
          text = new Text("", 0, 0);
          readTextByCallId.set(context.toolCallId, text);
        }
        const baseContext = { ...context, lastComponent: text };
        readDef.renderResult!(result, options, theme, baseContext);
        return renderTextResultWithCompression(text, result.details, theme, options.isPartial);
      },
    });
    pi.registerTool({
      ...grepDef,
      renderResult: (result, options, theme, context) => {
        let text = grepTextByCallId.get(context.toolCallId);
        if (!text) {
          text = new Text("", 0, 0);
          grepTextByCallId.set(context.toolCallId, text);
        }
        const baseContext = { ...context, lastComponent: text };
        grepDef.renderResult!(result, options, theme, baseContext);
        return renderTextResultWithCompression(text, result.details, theme, options.isPartial);
      },
    });
    pi.registerTool({
      ...lsDef,
      renderResult: (result, options, theme, context) => {
        let text = lsTextByCallId.get(context.toolCallId);
        if (!text) {
          text = new Text("", 0, 0);
          lsTextByCallId.set(context.toolCallId, text);
        }
        const baseContext = { ...context, lastComponent: text };
        lsDef.renderResult!(result, options, theme, baseContext);
        return renderTextResultWithCompression(text, result.details, theme, options.isPartial);
      },
    });
    pi.registerTool({
      ...findDef,
      renderResult: (result, options, theme, context) => {
        let text = findTextByCallId.get(context.toolCallId);
        if (!text) {
          text = new Text("", 0, 0);
          findTextByCallId.set(context.toolCallId, text);
        }
        const baseContext = { ...context, lastComponent: text };
        findDef.renderResult!(result, options, theme, baseContext);
        return renderTextResultWithCompression(text, result.details, theme, options.isPartial);
      },
    });
  });
}
import "pi-subagents";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

declare const toolResult: AgentToolResult<unknown>;

const observableError: boolean | undefined = toolResult.isError;

void observableError;

import "pi-subagents";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

declare const toolResult: ToolResultEvent;

const observableError: boolean | undefined = toolResult.isError;

void observableError;

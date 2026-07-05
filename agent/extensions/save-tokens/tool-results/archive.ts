import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ArchiveOriginalInput } from "./types";

export async function archiveOriginalToolResult(input: ArchiveOriginalInput): Promise<string | null> {
  const archiveRoot = process.env.PI_TOOL_RESULT_ARCHIVE_DIR?.trim() || join(homedir(), ".pi", "agent", "tool-result-archive");
  const digest = createHash("sha256").update(input.text).digest("hex").slice(0, 12);
  const safeToolCallId = input.toolCallId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const safeToolName = input.toolName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const filePath = join(archiveRoot, `${Date.now()}-${safeToolName}-${safeToolCallId}-${digest}.txt`);
  const header = [
    `toolCallId: ${input.toolCallId}`,
    `toolName: ${input.toolName}`,
    input.subject ? `subject: ${input.subject}` : undefined,
    `archivedAt: ${new Date().toISOString()}`,
    "",
  ].filter(Boolean).join("\n");
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(filePath, `${header}${input.text}`, "utf8");
  return filePath;
}
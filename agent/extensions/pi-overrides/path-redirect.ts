import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ReadToolDetails, LsToolDetails } from "@earendil-works/pi-coding-agent";

/**
 * Returned when read() is called on a directory — returns an ls-like listing
 * with a clear header so the LLM knows it's a directory, not file contents.
 */
export async function handleReadOnDirectory(
  absolutePath: string,
  readdir: (path: string) => Promise<string[]>,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
  const entries = await readdir(absolutePath);
  entries.sort((a, b) => a.localeCompare(b));

  const lines: string[] = [
    `Path is a directory. Contents of ${absolutePath}/:`,
    "",
  ];

  if (entries.length === 0) {
    lines.push("(empty directory)");
  } else {
    lines.push(...entries);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: undefined,
  };
}

/**
 * Returned when ls() is called on a file — returns stat info plus the first
 * 20 lines of content so the LLM gets immediate context.
 */
export async function handleLsOnFile(
  absolutePath: string,
  readFile: (path: string) => Promise<Buffer>,
  statFn: (path: string) => Promise<{ size: number; mtime: Date }>,
): Promise<AgentToolResult<LsToolDetails | undefined>> {
  const st = await statFn(absolutePath);

  // Binary detection: check first 512 bytes for null bytes
  const head = await readFile(absolutePath).then(
    (buf) => buf.subarray(0, Math.min(512, buf.length)),
    () => Buffer.alloc(0),
  );
  const isBinary = head.includes(0);

  const lines: string[] = [
    `Path is a file.`,
    `Size: ${st.size} bytes`,
    `Modified: ${st.mtime.toISOString()}`,
    "",
  ];

  if (st.size === 0) {
    lines.push("(empty file)");
  } else if (isBinary) {
    lines.push("(binary file, preview skipped)");
  } else {
    const buf = await readFile(absolutePath);
    const text = buf.toString("utf-8", 0, Math.min(buf.length, 100_000));
    const contentLines = text.split("\n");
    const preview = contentLines.slice(0, 20);

    lines.push("First 20 lines:");
    lines.push(...preview);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: undefined,
  };
}

import { describe, expect, it, mock } from "bun:test";
import {
  appendCompressionEvent,
  COMPRESSION_EVENT_ENTRY_TYPE,
  findCompressionEventByToolCallId,
  getLatestCompressionEvent,
  listCompressionEvents,
  type CompressionEventPayload,
} from "./compression-protocol";

function makeCompressedEvent(
  toolCallId: string,
  toolName: string,
  timestamp: number,
): CompressionEventPayload {
  return {
    toolCallId,
    toolName,
    timestamp,
    kind: "compressed",
    originalLength: 100,
    compressedLength: 40,
    savedBytes: 60,
    savedPct: 60,
  };
}

describe("compression protocol", () => {
  it("appends protocol entry with canonical custom type", () => {
    const appendEntry = mock(() => undefined);
    appendCompressionEvent({ appendEntry }, makeCompressedEvent("t1", "read", 1));
    expect(appendEntry).toHaveBeenCalledWith(
      COMPRESSION_EVENT_ENTRY_TYPE,
      makeCompressedEvent("t1", "read", 1),
    );
  });

  it("lists only compression events and deduplicates by toolCallId with last write winning", () => {
    const entries = [
      { type: "custom", customType: "other:event", data: { nope: true }, id: "e0" },
      { type: "custom", customType: COMPRESSION_EVENT_ENTRY_TYPE, data: makeCompressedEvent("t1", "read", 1), id: "e1" },
      { type: "custom", customType: COMPRESSION_EVENT_ENTRY_TYPE, data: makeCompressedEvent("t2", "grep", 2), id: "e2" },
      {
        type: "custom",
        customType: COMPRESSION_EVENT_ENTRY_TYPE,
        data: {
          toolCallId: "t1",
          toolName: "read",
          timestamp: 3,
          kind: "skipped",
          originalLength: 100,
          reason: "no_change",
        },
        id: "e3",
      },
    ];

    expect(listCompressionEvents(entries)).toEqual([
      {
        toolCallId: "t2",
        toolName: "grep",
        timestamp: 2,
        kind: "compressed",
        originalLength: 100,
        compressedLength: 40,
        savedBytes: 60,
        savedPct: 60,
      },
      {
        toolCallId: "t1",
        toolName: "read",
        timestamp: 3,
        kind: "skipped",
        originalLength: 100,
        reason: "no_change",
      },
    ]);
  });

  it("finds an event by toolCallId after deduplication", () => {
    const entries = [
      { type: "custom", customType: COMPRESSION_EVENT_ENTRY_TYPE, data: makeCompressedEvent("t1", "read", 1), id: "e1" },
      {
        type: "custom",
        customType: COMPRESSION_EVENT_ENTRY_TYPE,
        data: {
          toolCallId: "t1",
          toolName: "read",
          timestamp: 4,
          kind: "failed",
          originalLength: 100,
          reason: "service_error",
        },
        id: "e2",
      },
    ];

    expect(findCompressionEventByToolCallId(entries, "t1")).toEqual({
      toolCallId: "t1",
      toolName: "read",
      timestamp: 4,
      kind: "failed",
      originalLength: 100,
      reason: "service_error",
    });
  });

  it("gets the latest event globally or for a given tool name", () => {
    const entries = [
      { type: "custom", customType: COMPRESSION_EVENT_ENTRY_TYPE, data: makeCompressedEvent("t1", "read", 1), id: "e1" },
      { type: "custom", customType: COMPRESSION_EVENT_ENTRY_TYPE, data: makeCompressedEvent("t2", "grep", 5), id: "e2" },
      { type: "custom", customType: COMPRESSION_EVENT_ENTRY_TYPE, data: makeCompressedEvent("t3", "read", 3), id: "e3" },
    ];

    expect(getLatestCompressionEvent(entries)?.toolCallId).toBe("t2");
    expect(getLatestCompressionEvent(entries, "read")?.toolCallId).toBe("t3");
  });
});
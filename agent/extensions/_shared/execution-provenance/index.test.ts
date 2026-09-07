import { expect, test } from 'bun:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { addExecutionContext, hostExecution, unknownExecution, parseExecutionProvenance, recordExecution } from './index.ts';

test('context copies preserve raw text, images, historical facts and unknown history', () => {
    const messages: AgentMessage[] = [{ role: 'toolResult', toolCallId: 'past', toolName: 'read', content: [{ type: 'text', text: 'raw' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }], isError: false, timestamp: 1, details: { execution: hostExecution(), executionReceiptVisible: false } }, { role: 'toolResult', toolCallId: 'old', toolName: 'bash', content: [{ type: 'text', text: 'old' }], isError: false, timestamp: 2 }];
    const original = JSON.stringify(messages);
    recordExecution('past', { ...hostExecution(), outcome: 'failed' });
    const first = addExecutionContext(messages);
    expect(JSON.stringify(messages)).toBe(original);
    expect(first[0].role === 'toolResult' && first[0].content[1]).toEqual({ type: 'image', data: 'AA==', mimeType: 'image/png' });
    expect(JSON.stringify(first[0])).toContain('Execution provenance:');
    expect(JSON.stringify(first[0])).not.toContain('failed');
    expect(JSON.stringify(first[1])).toContain('unknown');
    expect(addExecutionContext(first)).toEqual(first);
});

test('wire provenance rejects non-scalar values and does not copy arbitrary data', () => {
    expect(parseExecutionProvenance({ ...hostExecution(), status: { toString: () => 'unsandboxed' } })).toBeUndefined();
    expect(parseExecutionProvenance({ ...hostExecution(), raw: 'do not propagate' })).toEqual(hostExecution());
});

test('Think JSON failure is its own receipt and remains parseable', () => {
    const message: AgentMessage = { role: 'toolResult', toolCallId: 'think-error', toolName: 'think_execute', content: [{ type: 'text', text: JSON.stringify({ tool: 'think_execute', status: 'error', sourceExecution: hostExecution(), analysisExecution: hostExecution() }) }], isError: true, timestamp: 1 };
    expect(addExecutionContext([message])[0]).toEqual(message);
});

test('model context identifies archived output text independently from source execution', () => {
    const message: AgentMessage = { role: 'toolResult', toolCallId: 'archived', toolName: 'read', content: [{ type: 'text', text: 'page' }], isError: false, timestamp: 1, details: { execution: hostExecution(), outputArchive: { kind: 'output-text', sourceExecution: unknownExecution(), storage: hostExecution() } } };
    const result = addExecutionContext([message]);
    expect(JSON.stringify(result)).toContain('Output archive:');
    expect(JSON.stringify(message)).not.toContain('Output archive:');
});

test('user bash context is idempotent and keeps legacy status unknown', () => {
    const message: AgentMessage = { role: 'bashExecution', command: 'true', output: 'raw', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 };
    const decorated = addExecutionContext([message]);
    expect(addExecutionContext(decorated)).toEqual(decorated);
    expect(JSON.stringify(decorated)).toContain('unknown');
    expect(message.output).toBe('raw');
});

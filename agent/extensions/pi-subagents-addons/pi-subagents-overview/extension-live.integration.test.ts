import { describe, expect, it } from 'bun:test';
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import registerSubagentsOverview from './index.ts';
import {
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    SUBAGENT_RPC_REQUEST_EVENT,
} from './rpc-client.ts';

describe('pi-subagents-overview live integration', () => {
    it('installs the live widget for an active fleet and removes it on shutdown', async () => {
        type Handler = (
            event: { type: string },
            ctx: ExtensionContext,
        ) => void | Promise<void>;
        const extensionHandlers = new Map<string, Handler>();
        const busHandlers = new Map<string, Set<(data: unknown) => void>>();
        const widgetChanges: Array<{ key: string; content: unknown }> = [];
        const emittedEvents: string[] = [];
        const events = {
            on: (event: string, handler: (data: unknown) => void) => {
                const handlers = busHandlers.get(event) ?? new Set();
                handlers.add(handler);
                busHandlers.set(event, handlers);
                return () => handlers.delete(handler);
            },
            emit: (event: string, data: unknown) => {
                emittedEvents.push(event);
                if (event === SUBAGENT_RPC_REQUEST_EVENT) {
                    const request = data as { requestId: string; method: string };
                    const responseData =
                        request.method === 'ping'
                            ? { capabilities: { fleetStatus: { version: 1 } } }
                            : {
                                  fleet: {
                                      version: 1,
                                      entries: [
                                          {
                                              key: 'fleet-1',
                                              agent: 'worker',
                                              startedAt: Date.now(),
                                              tokens: {
                                                  input: 1,
                                                  output: 1,
                                                  total: 2,
                                              },
                                          },
                                      ],
                                      totalActive: 1,
                                      omitted: 0,
                                  },
                              };
                    queueMicrotask(() =>
                        events.emit(
                            `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`,
                            {
                                version: 1,
                                requestId: request.requestId,
                                method: request.method,
                                success: true,
                                data: responseData,
                            },
                        ),
                    );
                }
                for (const handler of busHandlers.get(event) ?? []) handler(data);
            },
        };
        const pi = {
            events,
            registerMessageRenderer: () => {},
            registerCommand: () => {},
            on: (event: string, handler: Handler) =>
                extensionHandlers.set(event, handler),
        } as unknown as ExtensionAPI;
        registerSubagentsOverview(pi);
        const ctx = {
            mode: 'tui',
            hasUI: true,
            sessionManager: { getSessionId: () => 'session-1' },
            ui: {
                setWidget: (key: string, content: unknown) =>
                    widgetChanges.push({ key, content }),
            },
        } as unknown as ExtensionContext;

        await extensionHandlers.get('session_start')?.(
            { type: 'session_start' },
            ctx,
        );
        expect(
            widgetChanges.some(
                (change) =>
                    change.key === 'pi-subagents-live-widget' &&
                    typeof change.content === 'function',
            ),
        ).toBe(true);

        await extensionHandlers.get('session_shutdown')?.(
            { type: 'session_shutdown' },
            ctx,
        );
        expect(widgetChanges.at(-1)).toEqual({
            key: 'pi-subagents-live-widget',
            content: undefined,
        });
        emittedEvents.length = 0;
        await Bun.sleep(550);
        expect(emittedEvents).not.toContain('pi-fancy-footer:request-widget-refresh');
        expect(emittedEvents).not.toContain(SUBAGENT_RPC_REQUEST_EVENT);
    });

    it('prompts for steer, confirms destructive controls, and surfaces RPC errors', async () => {
        type Handler = (
            event: { type: string },
            ctx: ExtensionContext,
        ) => void | Promise<void>;
        const extensionHandlers = new Map<string, Handler>();
        const busHandlers = new Map<string, Set<(data: unknown) => void>>();
        const requests: Array<{
            method: string;
            params?: Record<string, unknown>;
        }> = [];
        const confirmations: string[] = [];
        const notifications: Array<{ message: string; level: string }> = [];
        let overviewHandler:
            | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
            | undefined;
        const events = {
            on: (event: string, handler: (data: unknown) => void) => {
                const handlers = busHandlers.get(event) ?? new Set();
                handlers.add(handler);
                busHandlers.set(event, handlers);
                return () => handlers.delete(handler);
            },
            emit: (event: string, data: unknown) => {
                if (event === SUBAGENT_RPC_REQUEST_EVENT) {
                    const request = data as {
                        requestId: string;
                        method: string;
                        params?: Record<string, unknown>;
                    };
                    requests.push({
                        method: request.method,
                        params: request.params,
                    });
                    queueMicrotask(() =>
                        events.emit(
                            `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`,
                            {
                                version: 1,
                                requestId: request.requestId,
                                method: request.method,
                                success: request.method !== 'interrupt',
                                ...(request.method === 'interrupt'
                                    ? {
                                          error: {
                                              code: 'denied',
                                              message: 'denied by test',
                                          },
                                      }
                                    : {
                                          data:
                                              request.method === 'ping'
                                                  ? { capabilities: {} }
                                                  : {},
                                      }),
                            },
                        ),
                    );
                }
                for (const handler of busHandlers.get(event) ?? []) handler(data);
            },
        };
        const pi = {
            events,
            registerMessageRenderer: () => {},
            registerCommand: (
                name: string,
                command: {
                    handler: (
                        args: string,
                        ctx: ExtensionCommandContext,
                    ) => Promise<void>;
                },
            ) => {
                if (name === 'subagents-overview') {
                    overviewHandler = command.handler;
                }
            },
            on: (event: string, handler: Handler) =>
                extensionHandlers.set(event, handler),
        } as unknown as ExtensionAPI;
        registerSubagentsOverview(pi);
        const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
        } as unknown as Theme;
        const ctx = {
            mode: 'tui',
            hasUI: true,
            sessionManager: { getSessionId: () => 'session-1' },
            ui: {
                setWidget: () => {},
                input: async () => 'Continue carefully',
                confirm: async (title: string) => {
                    confirmations.push(title);
                    return true;
                },
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
                custom: async (
                    factory: (
                        tui: { requestRender(): void },
                        theme: Theme,
                        kb: unknown,
                        done: (value: unknown) => void,
                    ) => Component & { dispose?(): void },
                ) => {
                    const view = factory(
                        { requestRender: () => {} },
                        theme,
                        undefined,
                        () => {},
                    );
                    view.handleInput?.('\t');
                    view.handleInput?.('\t');
                    for (const key of ['s', 'i', 'x']) view.handleInput?.(key);
                    await Bun.sleep(20);
                    view.dispose?.();
                    return undefined;
                },
            },
        } as unknown as ExtensionCommandContext;

        await extensionHandlers.get('session_start')?.(
            { type: 'session_start' },
            ctx,
        );
        events.emit('subagent:async-started', {
            id: 'async-1',
            sessionId: 'session-1',
            asyncDir: '/tmp/missing-is-safe',
            agent: 'worker',
        });
        await overviewHandler?.('', ctx);

        expect(confirmations).toEqual(['Interrupt subagent', 'Stop subagent']);
        expect(
            requests
                .filter((request) =>
                    ['steer', 'interrupt', 'stop'].includes(request.method),
                )
                .map((request) => ({
                    method: request.method,
                    params: request.params,
                })),
        ).toEqual([
            {
                method: 'steer',
                params: { id: 'async-1', message: 'Continue carefully' },
            },
            { method: 'interrupt', params: { id: 'async-1' } },
            { method: 'stop', params: { id: 'async-1' } },
        ]);
        expect(notifications).toContainEqual({
            message: 'denied by test',
            level: 'error',
        });
        await extensionHandlers.get('session_shutdown')?.(
            { type: 'session_shutdown' },
            ctx,
        );
    });
});

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    fauxProvider,
    fauxAssistantMessage,
    fauxToolCall,
    getCurrentTools,
    type FauxResponseFactory,
} from '@earendil-works/pi-ai';
import {
    createMcpToolName,
    getAgentDir,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { DelegationClient as ReferenceForeground } from '../../extensions/_shared/subagents/foreground-client.ts';
import {
    SubagentIntegration,
    preflightSubagent,
} from '../../extensions/_shared/subagents/index.ts';
import { SubagentRpcClient } from '../../extensions/_shared/subagents/rpc-client.ts';

/** Only provider responses are synthetic. The CLI, SDK, child processes and loopback MCP stay real. */
export default function fixture(pi: ExtensionAPI): void {
    const mcpProbe = createMcpToolName('fixture', 'echo');
    const child = fauxProvider({
        provider: 'baseline-child',
        models: [
            {
                id: 'target',
                reasoning: true,
                contextWindow: 100000,
                maxTokens: 2048,
            },
            {
                id: 'parent',
                reasoning: true,
                contextWindow: 100000,
                maxTokens: 2048,
            },
        ],
    });
    const respond: FauxResponseFactory = async (
        context,
        options,
        _state,
        model,
    ) => {
        child.appendResponses([respond]);
        const tools = getCurrentTools(context.messages).map(
            (tool) => tool.name,
        );
        const task = JSON.stringify(context.messages);
        const evidence = {
            time: Date.now(),
            pid: process.pid,
            rss: process.memoryUsage().rss,
            runtime: process.versions.bun ? 'bun' : 'node',
            executable: process.execPath,
            sdkRoot: process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,
            model: `${model.provider}/${model.id}`,
            reasoning: options?.reasoning,
            tools,
            task,
        };
        appendFileSync(
            join(process.cwd(), 'calls.jsonl'),
            JSON.stringify(evidence) + '\n',
        );
        if (tools.includes('subagent')) {
            const nested = context.messages.find(
                (message) =>
                    message.role === 'toolResult' &&
                    message.toolName === 'subagent',
            );
            if (!nested)
                return fauxAssistantMessage(
                    fauxToolCall('subagent', {
                        agent: 'reader',
                        task: 'nested-fixture',
                        context: 'fresh',
                        async: false,
                        skill: false,
                    }),
                );
            if (nested.role === 'toolResult' && nested.isError)
                throw new Error('Nested configured child failed.');
        }
        if (
            tools.includes('fixture_ping') &&
            !context.messages.some(
                (message) =>
                    message.role === 'toolResult' &&
                    message.toolName === 'fixture_ping',
            )
        )
            return fauxAssistantMessage(fauxToolCall('fixture_ping', {}));
        const probe = tools.includes(mcpProbe) ? mcpProbe : 'read';
        if (
            !context.messages.some(
                (message) =>
                    message.role === 'toolResult' && message.toolName === probe,
            )
        )
            return fauxAssistantMessage(
                fauxToolCall(
                    probe,
                    probe === 'read'
                        ? { path: 'proof.txt' }
                        : { message: 'baseline' },
                ),
            );
        if (task.includes('HOLD') && !task.includes('baseline-resume')) {
            const signal = options?.signal;
            if (!signal) throw new Error('Missing child cancellation signal.');
            if (!signal.aborted)
                await new Promise<void>((resolve) =>
                    signal.addEventListener('abort', () => resolve(), {
                        once: true,
                    }),
                );
        }
        if (
            tools.includes('structured_output') &&
            !context.messages.some(
                (message) =>
                    message.role === 'toolResult' &&
                    message.toolName === 'structured_output',
            )
        )
            return fauxAssistantMessage(
                fauxToolCall('structured_output', { value: { proof: true } }),
            );
        return fauxAssistantMessage('baseline-complete');
    };
    child.setResponses([respond]);
    pi.registerProvider(child.provider);
    const parent = fauxProvider({
        provider: 'baseline-parent',
        models: [{ id: 'driver', contextWindow: 100000, maxTokens: 2048 }],
    });
    pi.registerProvider(parent.provider);
    let integration = new SubagentIntegration(pi.events, {
        sourceExtension: 'baseline',
        timeoutMs: 30000,
    });
    const rpc = new SubagentRpcClient(pi.events, {
        sourceExtension: 'baseline-reference',
        timeoutMs: 30000,
    });
    const foreground = new ReferenceForeground(pi.events);
    const references = new Map<
        string,
        Awaited<ReturnType<typeof integration.start>>
    >();
    const schema = {
        type: 'object',
        properties: { proof: { type: 'boolean' } },
        required: ['proof'],
        additionalProperties: false,
    };
    pi.on('session_start', (_event, ctx) =>
        console.log(
            JSON.stringify({
                type: 'baseline_ready',
                pid: process.pid,
                sdkRoot: process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,
                entrypoint: process.argv[1],
                sessionId:
                    ctx.sessionManager.getSessionFile() ??
                    ctx.sessionManager.getSessionId(),
                packages: JSON.parse(
                    readFileSync(join(getAgentDir(), 'settings.json'), 'utf8'),
                ).packages,
            }),
        ),
    );
    integration.subscribe((event) =>
        console.log(
            JSON.stringify(
                event.kind === 'terminal'
                    ? {
                          type: 'baseline_terminal',
                          ...event.completion,
                          time: Date.now(),
                      }
                    : { type: 'baseline_error', error: event.error.message },
            ),
        ),
    );
    rpc.onAsyncComplete((completion) =>
        console.log(
            JSON.stringify({
                type: 'baseline_native_terminal',
                completion,
                time: Date.now(),
            }),
        ),
    );
    pi.registerCommand('baseline', {
        description: 'Run one isolated baseline scenario',
        handler: async (args, ctx) => {
            const [scenario, id = 'sample'] = args.split(' ');
            const start = Date.now();
            try {
                const launch = {
                    agent:
                        scenario === 'configured-nested'
                            ? 'coordinator'
                            : scenario?.startsWith('builtin-')
                              ? 'scout'
                              : 'reader',
                    task: `baseline ${id}`,
                    context: 'fresh' as const,
                    cwd: ctx.cwd,
                    skill: false,
                    artifacts: true,
                    result: { kind: 'structured' as const, schema },
                };
                const candidate = process.env.PI_BASELINE_ARM === 'candidate';
                if (
                    scenario === 'change-model' ||
                    scenario === 'restore-model'
                ) {
                    const path = join(getAgentDir(), 'settings.json');
                    const settings = JSON.parse(readFileSync(path, 'utf8'));
                    for (const agent of ['scout', 'reader'])
                        settings.subagents.agentOverrides[agent] = {
                            model:
                                scenario === 'change-model'
                                    ? 'baseline-child/parent'
                                    : 'baseline-child/target',
                            thinking:
                                scenario === 'change-model' ? 'low' : 'high',
                        };
                    writeFileSync(path, JSON.stringify(settings));
                    console.log(
                        JSON.stringify({
                            type: 'baseline_receipt',
                            id,
                            start,
                            end: Date.now(),
                            result: { changed: true },
                        }),
                    );
                    return;
                }
                if (scenario === 'inspect-restored') {
                    integration.dispose();
                    integration = new SubagentIntegration(pi.events, {
                        sourceExtension: 'baseline',
                        timeoutMs: 30000,
                    });
                    const ref = references.get(id);
                    if (!ref) throw new Error(`Unknown fixture run ${id}.`);
                    console.log(
                        JSON.stringify({
                            type: 'baseline_receipt',
                            id,
                            start,
                            end: Date.now(),
                            result: await integration.wait(ref, {
                                timeoutMs: 10000,
                            }),
                        }),
                    );
                    return;
                }
                if (scenario === 'warm') {
                    parent.setResponses([
                        fauxAssistantMessage(
                            fauxToolCall(mcpProbe, { message: 'warm' }),
                        ),
                        fauxAssistantMessage('warmed'),
                    ]);
                    await ctx.waitForIdle();
                    pi.sendUserMessage('warm fixture');
                    return;
                }
                if (scenario === 'direct') {
                    parent.setResponses([
                        fauxAssistantMessage(
                            fauxToolCall('subagent', {
                                agent: 'scout',
                                task: launch.task,
                                context: 'fresh',
                                async: false,
                                outputSchema: schema,
                                skill: false,
                            }),
                        ),
                        fauxAssistantMessage('done'),
                    ]);
                    pi.sendUserMessage('direct fixture');
                    return;
                }
                if (scenario === 'preflight') {
                    console.log(
                        JSON.stringify({
                            type: 'baseline_receipt',
                            id,
                            start,
                            end: Date.now(),
                            result: await preflightSubagent({
                                agent: 'scout',
                                agentScope: 'both',
                                projectTrusted: true,
                                cwd: ctx.cwd,
                                context: 'fresh',
                                parentModel: {
                                    provider: 'baseline-child',
                                    id: 'parent',
                                },
                            }),
                        }),
                    );
                    return;
                }
                if (
                    scenario === 'interrupt' ||
                    scenario === 'resume' ||
                    scenario === 'stop'
                ) {
                    const ref =
                        references.get(id) ??
                        [...references.values()].find(
                            (ref) => ref.runId === id,
                        );
                    if (!ref) throw new Error(`Unknown fixture run ${id}.`);
                    const result =
                        scenario === 'resume'
                            ? candidate
                                ? await integration.resume(
                                      ref,
                                      'baseline-resume',
                                  )
                                : await rpc.resume({
                                      id: ref.runId,
                                      message: 'baseline-resume',
                                  })
                            : candidate
                              ? await integration.control(ref, {
                                    kind: scenario,
                                })
                              : await rpc[scenario]({ id: ref.runId });
                    if (scenario === 'resume') {
                        if ('runId' in result) references.set(id, result);
                        else if ('details' in result && result.details?.asyncId)
                            references.set(id, {
                                ...ref,
                                runId: String(result.details.asyncId),
                            });
                        else
                            throw new Error(
                                'Resume did not return a run identity.',
                            );
                    }
                    console.log(
                        JSON.stringify({
                            type: 'baseline_receipt',
                            id,
                            start,
                            end: Date.now(),
                            result,
                        }),
                    );
                    return;
                }
                if (
                    scenario === 'foreground' ||
                    scenario === 'builtin-foreground' ||
                    scenario === 'configured-nested'
                ) {
                    const request = {
                        ...launch,
                        requestId: id,
                        ownerRunId: 'baseline',
                        nodeId: id,
                    };
                    const result = await (
                        candidate ? integration : foreground
                    ).run(request, { deadlineMs: 45000 });
                    console.log(
                        JSON.stringify({
                            type: 'baseline_receipt',
                            id,
                            start,
                            end: Date.now(),
                            result,
                        }),
                    );
                    return;
                }
                let ref;
                if (
                    scenario === 'parallel' ||
                    scenario === 'dependent' ||
                    scenario === 'builtin-workflow'
                ) {
                    const items = (
                        scenario === 'builtin-workflow'
                            ? ['first']
                            : ['first', 'second', 'third']
                    ).map((key) => ({
                        ...launch,
                        key,
                        task: `baseline ${id} ${key}`,
                    }));
                    const stages = [
                        items,
                        ...(scenario === 'dependent'
                            ? [
                                  [
                                      {
                                          ...launch,
                                          key: 'advisory',
                                          task: `baseline ${id} assess {outputs.first}`,
                                      },
                                  ],
                              ]
                            : []),
                    ];
                    if (candidate)
                        ref = await integration.start({ cwd: ctx.cwd, stages });
                    else {
                        const workflowScript = `const items = ${JSON.stringify(items.map(({ result, ...item }) => ({ ...item, outputSchema: result.schema })))}; const results = await runs.all(items); if(results.some(r => !r.ok)) return { results }; ${scenario === 'dependent' ? `const advisory = await runs.run('advisory', { agent: 'reader', task: ${JSON.stringify(`baseline ${id} assess `)} + JSON.stringify(results[0].structuredOutput), context: 'fresh', skill: false, outputSchema: ${JSON.stringify(schema)} }); return {results, advisory};` : 'return {results};'}`;
                        const result = await rpc.spawn({
                            cwd: ctx.cwd,
                            script: workflowScript,
                            async: true,
                            mission: false,
                        });
                        ref = {
                            runId: String(result.details?.asyncId),
                            sessionId:
                                ctx.sessionManager.getSessionFile() ??
                                ctx.sessionManager.getSessionId(),
                        };
                    }
                } else if (candidate)
                    ref = await integration.start({
                        ...launch,
                        task:
                            scenario === 'hold' || scenario === 'builtin-hold'
                                ? `baseline ${id} HOLD`
                                : launch.task,
                    });
                else {
                    const result = await rpc.spawn({
                        ...launch,
                        result: undefined,
                        outputSchema: schema,
                        async: true,
                        task:
                            scenario === 'hold'
                                ? `baseline ${id} HOLD`
                                : launch.task,
                    });
                    ref = {
                        runId: String(result.details?.asyncId),
                        sessionId:
                            ctx.sessionManager.getSessionFile() ??
                            ctx.sessionManager.getSessionId(),
                    };
                }
                references.set(id, ref);
                console.log(
                    JSON.stringify({
                        type: 'baseline_receipt',
                        id,
                        start,
                        end: Date.now(),
                        result: ref,
                    }),
                );
            } catch (error) {
                console.log(
                    JSON.stringify({
                        type: 'baseline_error',
                        id,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    }),
                );
            }
        },
    });
    pi.on('session_shutdown', () => {
        integration.dispose();
        rpc.dispose();
        foreground.dispose();
    });
}

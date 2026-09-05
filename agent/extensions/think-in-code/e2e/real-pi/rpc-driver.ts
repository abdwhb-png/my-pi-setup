interface RpcEvent {
    type?: string;
    id?: string;
    success?: boolean;
    data?: unknown;
}

export {};

const realPiBun = process.argv[2];
const session = process.argv[3];
const sessionDir = process.argv[4];
const outputPath = process.argv[5];
if (!realPiBun || !session || !sessionDir || !outputPath) {
    throw new Error(
        "usage: rpc-driver <real-pi-bun> <session> <session-dir> <output>",
    );
}

const child = Bun.spawn(
    [
        realPiBun,
        "--mode",
        "rpc",
        "--session",
        session,
        "--session-dir",
        sessionDir,
        "--provider",
        "think-smoke",
        "--model",
        "smoke",
        "--dangerously-skip-permissions",
        "--verbose",
        "--approve",
        "--offline",
    ],
    {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            PI_PACKAGE_FINALIZER_ACTIVE: "1",
            PI_TOOL_GROUPS_REQUESTED_TOOLS: JSON.stringify(["@think"]),
        },
    },
);

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const output = Bun.file(outputPath).writer();
const pending = new Map<string, (event: RpcEvent) => void>();
let stdoutBuffer = "";

async function consumeStdout(): Promise<void> {
    for await (const chunk of child.stdout) {
        stdoutBuffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
            const line = stdoutBuffer.slice(0, newline);
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!line.trim()) continue;
            await output.write(`${line}\n`);
            if (!line.startsWith("{")) continue;
            const event = JSON.parse(line) as RpcEvent;
            if (event.type === "response" && event.id) {
                pending.get(event.id)?.(event);
                pending.delete(event.id);
            }
        }
    }
}

const stdoutTask = consumeStdout();
const stderrTask = new Response(child.stderr).text();

async function send(value: Record<string, unknown>): Promise<RpcEvent> {
    const id = String(value.id);
    const result = new Promise<RpcEvent>((resolve) => pending.set(id, resolve));
    await child.stdin.write(encoder.encode(`${JSON.stringify(value)}\n`));
    await child.stdin.flush();
    const response = await result;
    if (!response.success) throw new Error(JSON.stringify(response));
    return response;
}

async function waitIdle(): Promise<void> {
    for (;;) {
        const state = await send({
            id: `state-${crypto.randomUUID()}`,
            type: "get_state",
        });
        const data = state.data as
            | { isStreaming?: boolean; isCompacting?: boolean }
            | undefined;
        if (!data?.isStreaming && !data?.isCompacting) return;
        await Bun.sleep(25);
    }
}

await send({
    id: "seed",
    type: "prompt",
    message: `COMPACTION-SEED ${"z".repeat(100_000)}`,
});
await waitIdle();
await send({ id: "compact", type: "compact" });
await waitIdle();
await send({
    id: "post-compact-first",
    type: "prompt",
    message: "first prompt after compact",
});
await waitIdle();
await send({
    id: "post-compact-second",
    type: "prompt",
    message: "second prompt after compact",
});
await waitIdle();

child.kill("SIGTERM");
await child.exited;
await stdoutTask;
await output.end();
const stderr = await stderrTask;
await Bun.write(`${outputPath}.stderr`, stderr);
if (child.exitCode !== 0 && child.exitCode !== 143) {
    throw new Error(`Pi RPC exited ${child.exitCode}: ${stderr}`);
}

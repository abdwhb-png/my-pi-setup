export const echoTool = {
    name: "echo",
    description: "Echo a fixture message",
    inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
    },
};

/** Loopback-only MCP fixture shared by adapter and real child qualifications. */
export function startFixtureMcp(callsObserved: string[]) {
    return Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            if (request.method !== "POST")
                return new Response(null, { status: 405 });
            const body = await request.json();
            if (body.id === undefined)
                return new Response(null, { status: 202 });
            let result;
            switch (body.method) {
                case "initialize":
                    result = {
                        protocolVersion: body.params.protocolVersion,
                        capabilities: { tools: {} },
                        serverInfo: {
                            name: "qualification-fixture",
                            version: "1",
                        },
                    };
                    break;
                case "tools/list":
                    result = { tools: [echoTool] };
                    break;
                case "tools/call":
                    callsObserved.push(body.params.arguments.message);
                    result = {
                        content: [
                            {
                                type: "text",
                                text: `echo:${body.params.arguments.message}`,
                            },
                        ],
                    };
                    break;
                case "ping":
                    result = {};
                    break;
                default:
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        error: {
                            code: -32601,
                            message: "Unsupported fixture method",
                        },
                    });
            }
            return Response.json({ jsonrpc: "2.0", id: body.id, result });
        },
    });
}

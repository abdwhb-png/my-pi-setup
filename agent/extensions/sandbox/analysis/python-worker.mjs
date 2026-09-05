/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- Node must execute this Eryx JSPI worker as MJS without TypeScript's extra WASM runtime. Inputs are validated below. */
import { Sandbox, setOutputHandler, setResultVariable } from '@bsull/eryx';

const DEFAULT_LIMITS = Object.freeze({
    wallTimeMs: 60_000,
    cpuSeconds: 30,
    memoryBytes: 1024 ** 3,
    inputBytes: 64 * 1024 ** 2,
    outputBytes: 32 * 1024 ** 2,
});

function parseWorkerRequest(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Analysis request object is required');
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(value.id)) {
        throw new Error('Invalid analysis request id');
    }
    if (value.language !== 'python') {
        throw new Error(
            `Python cannot execute ${String(value.language)} requests`,
        );
    }
    if (typeof value.program !== 'string' || value.program.length === 0) {
        throw new Error('Analysis program must be a non-empty string');
    }
    const bindings = {};
    for (const [name, binding] of Object.entries(value.bindings ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`Invalid analysis binding name: ${name}`);
        }
        bindings[name] = normalizeBindingValue(binding);
    }
    return {
        id: value.id,
        language: 'python',
        worker: 'python',
        program: value.program,
        bindings,
        limits: { ...DEFAULT_LIMITS, ...value.limits },
    };
}

function normalizeBindingValue(value, depth = 0) {
    if (depth > 64) {
        throw new Error('Analysis binding nesting exceeds 64 levels');
    }
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
        return value.map((item) => normalizeBindingValue(item, depth + 1));
    }
    if (typeof value === 'object') {
        const normalized = {};
        for (const [name, item] of Object.entries(value)) {
            normalized[name] = normalizeBindingValue(item, depth + 1);
        }
        return normalized;
    }
    throw new Error('Analysis bindings must contain JSON-compatible values');
}

function pythonBindings(bindings) {
    return [
        'def _freeze_binding(value, _mapping_proxy=__import__("types").MappingProxyType):',
        '    if isinstance(value, list):',
        '        return tuple(_freeze_binding(item) for item in value)',
        '    if isinstance(value, dict):',
        '        return _mapping_proxy({key: _freeze_binding(item) for key, item in value.items()})',
        '    return value',
        '',
        ...Object.entries(bindings).map(
            ([name, value]) =>
                `${name} = _freeze_binding(__import__('json').loads(${JSON.stringify(JSON.stringify(value))}))`,
        ),
    ].join('\n');
}

function serialize(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    const serialized = JSON.stringify(value);
    return serialized ?? `[unserializable ${typeof value}]`;
}

function boundedResultCapture(outputBytes) {
    return [
        '',
        'if "result" in globals():',
        '    import json as __analysis_json',
        '    __analysis_value = result',
        '    if isinstance(__analysis_value, str):',
        '        __analysis_bytes = 0',
        '        for __analysis_offset in range(0, len(__analysis_value), 4096):',
        '            __analysis_bytes += len(__analysis_value[__analysis_offset:__analysis_offset + 4096].encode("utf-8"))',
        `            if __analysis_bytes > ${outputBytes}:`,
        `                raise RuntimeError("Analysis output exceeds ${outputBytes} bytes")`,
        '        __analysis_output = __analysis_value',
        '    else:',
        '        from collections.abc import Mapping as __analysis_mapping',
        '        def __analysis_json_default(value):',
        '            if isinstance(value, __analysis_mapping):',
        '                return dict(value)',
        '            raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")',
        '        __analysis_chunks = []',
        '        __analysis_bytes = 0',
        '        for __analysis_chunk in __analysis_json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), default=__analysis_json_default).iterencode(__analysis_value):',
        '            __analysis_bytes += len(__analysis_chunk.encode("utf-8"))',
        `            if __analysis_bytes > ${outputBytes}:`,
        `                raise RuntimeError("Analysis output exceeds ${outputBytes} bytes")`,
        '            __analysis_chunks.append(__analysis_chunk)',
        '        __analysis_output = "".join(__analysis_chunks)',
    ].join('\n');
}

export async function runPythonAnalysis(request) {
    if (request.worker !== 'python') {
        throw new Error(`Python cannot execute ${request.worker} requests`);
    }
    const sandbox = new Sandbox();
    await setResultVariable('__analysis_output');
    const code = `${pythonBindings(request.bindings)}\ntry:\n    del __analysis_output\nexcept NameError:\n    pass\n${request.program}${boundedResultCapture(request.limits.outputBytes)}`;
    let streamedBytes = 0;
    setOutputHandler((_stream, data) => {
        streamedBytes += Buffer.byteLength(data, 'utf8');
        if (streamedBytes > request.limits.outputBytes) {
            throw new Error(
                `Analysis output exceeds ${request.limits.outputBytes} bytes`,
            );
        }
    });
    let execution;
    try {
        execution = await sandbox.execute(code);
    } finally {
        setOutputHandler(null);
    }
    const output =
        execution.result === undefined
            ? execution.stdout.trimEnd()
            : serialize(execution.result);
    const stderr = execution.stderr.trimEnd();
    const outputBytes =
        execution.result === undefined
            ? streamedBytes
            : streamedBytes + Buffer.byteLength(output, 'utf8');
    if (outputBytes > request.limits.outputBytes) {
        throw new Error(
            `Analysis output exceeds ${request.limits.outputBytes} bytes`,
        );
    }
    return { output, stderr };
}

async function readStdin() {
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    return text;
}

if (import.meta.main) {
    try {
        const request = parseWorkerRequest(JSON.parse(await readStdin()));
        const result = await runPythonAnalysis(request);
        process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
        process.stdout.write(
            JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            }),
        );
    }
}

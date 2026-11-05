import { spawnSync } from "node:child_process";

/** Host-side Eryx tests use the available Node; sealed workers use the pinned distribution. */
export function nodeJspiArguments(nodePath: string): string[] {
    const check =
        "process.exit(typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' ? 0 : 78)";
    function available(args: string[]): boolean {
        const result = spawnSync(nodePath, [...args, "--eval", check], {
            encoding: "utf8",
            timeout: 5000,
            env: { PATH: process.env.PATH ?? "" },
        });
        if (result.error)
            throw new Error("Cannot inspect Node WebAssembly JSPI", {
                cause: result.error,
            });
        return result.status === 0;
    }
    if (available([])) return [];
    const experimental = ["--experimental-wasm-jspi"];
    if (available(experimental)) return experimental;
    throw new Error(
        "Node does not provide WebAssembly JSPI; use a JSPI-capable runtime for Python analysis.",
    );
}

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- Node's experimental ESM loader hook is an MJS package boundary. */
const PREVIEW2_FILESYSTEM = '@bytecodealliance/preview2-shim/filesystem';
const ERYX_PACKAGE_PATH = '/@bsull/eryx/';
const NODE_FILESYSTEM_PATH = '/lib/nodejs/filesystem.js';
const VIRTUAL_FILESYSTEM_PATH = '/lib/browser/filesystem.js';

export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    if (
        specifier !== PREVIEW2_FILESYSTEM ||
        !context.parentURL?.includes(ERYX_PACKAGE_PATH) ||
        !resolved.url.endsWith(NODE_FILESYSTEM_PATH)
    ) {
        return resolved;
    }

    return {
        ...resolved,
        url: resolved.url.replace(
            NODE_FILESYSTEM_PATH,
            VIRTUAL_FILESYSTEM_PATH,
        ),
        shortCircuit: true,
    };
}

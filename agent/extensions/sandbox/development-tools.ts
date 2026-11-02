import { spawnSync } from "node:child_process";
import {
    accessSync,
    constants,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    readdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import {
    parseGlobalInstallations,
    selectInstallations,
    validateGlobalInstallations,
    installationContains,
    type GlobalInstallations,
} from "./capabilities/installations.ts";
import {
    executableDependencies,
    executableLibraryDirectories,
} from "./executable-inspection.ts";

export interface DiscoveredTool {
    name: string;
    command: string;
    executable: string;
    version: string;
    source: string;
}
export interface ToolDiscovery {
    installations: GlobalInstallations;
    tools: DiscoveredTool[];
    unavailable: { name: string; reason: string }[];
    assertUnchanged(): void;
}

const PROBES: Record<string, string[]> = {
    node: [
        "-e",
        "console.log(JSON.stringify({executable:process.execPath,version:process.versions.node,resources:[]}))",
    ],
    bun: [
        "-e",
        "console.log(JSON.stringify({executable:process.execPath,version:Bun.version,resources:[]}))",
    ],
    python3: [
        "-I",
        "-S",
        "-B",
        "-c",
        'import json,sys,sysconfig; print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"resources":list(dict.fromkeys(p for p in [sysconfig.get_path("stdlib"),sysconfig.get_path("platstdlib"),sysconfig.get_config_var("DESTSHARED")] if p))}))',
    ],
    go: ["env", "-json", "GOROOT", "GOVERSION"],
    php: [
        "-r",
        '$r=array_filter(array_merge([php_ini_loaded_file(),ini_get("extension_dir"),is_dir("/usr/share/zoneinfo") ? "/usr/share/zoneinfo" : false],array_filter(explode(PATH_SEPARATOR,get_include_path()),fn($p)=>str_starts_with($p,DIRECTORY_SEPARATOR)),preg_split("/[,\\n]+/",php_ini_scanned_files() ?: ""))); echo json_encode(["executable"=>PHP_BINARY,"version"=>PHP_VERSION,"resources"=>array_values(array_map("trim",$r))]);',
    ],
    composer: ["--no-plugins", "--no-scripts", "--version"],
    pnpm: ["--version"],
};

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Tool requirements must be an object");
    return value as Record<string, unknown>;
}

/** Resolve declared tools only; never install packages or execute project code. */
export function resolveDevelopmentTools(
    requirements: unknown,
    options: {
        overrides?: unknown;
        existing?: unknown;
        rediscover?: boolean;
        path?: string;
        variables?: unknown;
    } = {},
): ToolDiscovery {
    const requests = object(requirements ?? {});
    // Reuse installation-name validation without requiring any host resource.
    validateGlobalInstallations(
        Object.fromEntries(
            Object.keys(requests).map((name) => [
                name,
                [{ root: homedir(), path: [] }],
            ]),
        ),
    );
    const overrides = validateGlobalInstallations(options.overrides);
    const existing = validateGlobalInstallations(options.existing);
    const variables = object(options.variables ?? {});
    const corepackHome = variables.COREPACK_HOME;
    if (
        corepackHome !== undefined &&
        (typeof corepackHome !== "string" ||
            (!isAbsolute(corepackHome) && !corepackHome.startsWith("~/")))
    )
        throw new Error(
            "COREPACK_HOME must be an absolute or home-relative path",
        );
    const watched = new Map<
        string,
        { value: string; permissionsOnly: boolean }
    >();
    const identity = (path: string, permissionsOnly = false) => {
        const value = statSync(path);
        const metadata = `${realpathSync(path)}:${value.dev}:${value.ino}:${value.uid}:${value.gid}:${value.mode}`;
        return permissionsOnly
            ? metadata
            : `${metadata}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    };
    const watch = (path: string, permissionsOnly = false) => {
        permissionsOnly =
            permissionsOnly && watched.get(path)?.permissionsOnly !== false;
        watched.set(path, {
            value: identity(path, permissionsOnly),
            permissionsOnly,
        });
    };
    const installations: GlobalInstallations = {};
    const tools: DiscoveredTool[] = [];
    const unavailable: ToolDiscovery["unavailable"] = [];
    for (const [name, request] of Object.entries(requests)) {
        if (!Array.isArray(request) || !request.length)
            throw new Error(`Unsupported tool requirements: ${name}`);
        const values: unknown[] = request;
        const commands: string[] = [];
        for (const command of values) {
            if (typeof command !== "string" || !Object.hasOwn(PROBES, command))
                throw new Error(`Unsupported tool requirements: ${name}`);
            commands.push(command);
        }
        try {
            const supplied =
                overrides[name] ??
                (!options.rediscover ? existing[name] : undefined);
            if (supplied) {
                installations[name] = parseGlobalInstallations(
                    { [name]: supplied },
                    !!overrides[name],
                )[name];
                selectInstallations({ [name]: installations[name] });
                for (const entry of installations[name]) {
                    watch(entry.root);
                    for (const file of entry.files ?? [])
                        watch(join(entry.root, file));
                }
                continue;
            }
            const roots: GlobalInstallations[string] = [];
            const files = new Set<string>();
            const addFile = (path: string, command = false) => {
                if (!isAbsolute(path))
                    throw new Error("Tool reported a relative resource");
                watch(path);
                const real = realpathSync(path);
                if (!statSync(real).isFile())
                    throw new Error(`Tool resource is not a file: ${path}`);
                if (files.has(path)) return;
                files.add(path);
                const parent = realpathSync(dirname(path));
                roots.push({
                    root: parent,
                    path: command ? ["."] : [],
                    files: [basename(path)],
                });
                // Keep loader aliases as exact file grants; never authorize their whole parent.
                if (parent !== dirname(path))
                    roots.push({ root: "/", path: [], files: [path.slice(1)] });
                if (real !== path) addFile(real);
                const dependencies = executableDependencies(readFileSync(real));
                for (const dependency of dependencies.absolute)
                    addFile(dependency);
                for (const library of dependencies.libraries) {
                    const searchDirectories = executableLibraryDirectories(
                        dependencies.search,
                        real,
                    );
                    const found = searchDirectories
                        .map((directory) => join(directory, library))
                        .find((file) => existsSync(file));
                    if (!found)
                        throw new Error(
                            `Unresolved library ${library} for ${path}; supply --bindings FILE`,
                        );
                    const canonicalParent = realpathSync(dirname(found));
                    // Retain the SONAME; omit an alias only when the canonical directory is also searched.
                    addFile(
                        searchDirectories.includes(canonicalParent)
                            ? join(canonicalParent, basename(found))
                            : found,
                    );
                }
            };
            const directories = new Set<string>();
            const addDirectory = (path: string) => {
                const real = realpathSync(path);
                if (
                    [
                        "/",
                        "/usr",
                        "/usr/local",
                        "/usr/lib",
                        "/lib",
                        "/lib64",
                        "/usr/lib64",
                        "/etc",
                        "/bin",
                        "/usr/bin",
                        "/sbin",
                        "/usr/sbin",
                        "/usr/local/bin",
                        "/usr/local/lib",
                        "/usr/lib/x86_64-linux-gnu",
                        "/lib/x86_64-linux-gnu",
                        tmpdir(),
                        dirname(homedir()),
                        homedir(),
                    ].includes(real)
                )
                    throw new Error(
                        `Refusing broad installation root: ${path}`,
                    );
                if (directories.has(real)) return;
                directories.add(real);
                watch(path);
                roots.push({ root: real, path: [] });
                let count = 0;
                const scan = (directory: string) => {
                    for (const entry of readdirSync(directory, {
                        withFileTypes: true,
                    })) {
                        if (++count > 100000)
                            throw new Error(
                                `Installation resource exceeds inspection limit: ${path}`,
                            );
                        const file = join(directory, entry.name);
                        if (entry.isDirectory()) scan(file);
                        else if (/\.so(?:\.|$)/.test(entry.name)) {
                            if (
                                readFileSync(file).subarray(0, 4).toString() !==
                                "\x7fELF"
                            )
                                throw new Error(
                                    `Shared-library candidate is not ELF: ${file}`,
                                );
                            addFile(file);
                        }
                    }
                };
                scan(real);
            };
            for (const command of commands) {
                const search = (options.path ?? process.env.PATH ?? "")
                    .split(delimiter)
                    .filter(isAbsolute);
                const candidate = search
                    .map((directory) => join(directory, command))
                    .find((path) => {
                        try {
                            accessSync(path, constants.X_OK);
                            return statSync(path).isFile();
                        } catch {
                            return false;
                        }
                    });
                if (!candidate)
                    throw new Error(
                        `Command ${command} not found on absolute PATH entries; install it or supply --bindings FILE`,
                    );
                watch(candidate);
                const mode = statSync(candidate).mode;
                let privateAncestor: string | undefined;
                if ((mode & 0o020) !== 0 && (mode & 0o002) === 0) {
                    // Vendor modes can allow group writes behind an owner-only directory.
                    for (
                        let parent = dirname(realpathSync(candidate));
                        parent !== dirname(parent);
                        parent = dirname(parent)
                    ) {
                        const metadata = statSync(parent);
                        if (
                            metadata.uid === process.geteuid?.() &&
                            (metadata.mode & 0o077) === 0
                        ) {
                            privateAncestor = parent;
                            watch(parent, true);
                            break;
                        }
                    }
                }
                if (
                    (mode & 0o002) !== 0 ||
                    ((mode & 0o020) !== 0 && !privateAncestor)
                )
                    throw new Error(
                        `Untrusted writable executable: ${candidate}`,
                    );
                const directory = mkdtempSync(join(tmpdir(), "pi-tool-probe-"));
                let data: Record<string, unknown>;
                let executable = candidate;
                try {
                    const env: Record<string, string> = {
                        HOME: homedir(),
                        PATH: search.join(delimiter),
                        MISE_AUTO_INSTALL: "0",
                        MISE_SELF_UPDATE_AUTO: "0",
                        MISE_CEILING_PATHS: directory,
                        COREPACK_ENABLE_NETWORK: "0",
                        GOENV: "off",
                        GOTOOLCHAIN: "local",
                        COMPOSER_ALLOW_SUPERUSER: "0",
                        COMPOSER_HOME: directory,
                    };
                    if (typeof corepackHome === "string")
                        env.COREPACK_HOME = corepackHome.startsWith("~/")
                            ? join(homedir(), corepackHome.slice(2))
                            : corepackHome;
                    for (const name of [
                        "XDG_CONFIG_HOME",
                        "XDG_DATA_HOME",
                        "XDG_CACHE_HOME",
                        "XDG_STATE_HOME",
                    ]) {
                        const value = process.env[name];
                        if (!value) continue;
                        if (!isAbsolute(value))
                            throw new Error(`${name} must be an absolute path`);
                        env[name] = value;
                    }
                    const query = (file: string, args: string[]) => {
                        const result = spawnSync(file, args, {
                            cwd: directory,
                            encoding: "utf8",
                            timeout: 5000,
                            maxBuffer: 128 * 1024,
                            env,
                        });
                        if (result.error || result.status !== 0)
                            throw new Error(
                                `Cannot inspect ${command}; automatic installs are disabled. Supply --bindings FILE`,
                            );
                        return result.stdout.trim();
                    };
                    if (basename(realpathSync(candidate)) === "mise") {
                        executable = query(realpathSync(candidate), [
                            "which",
                            command,
                        ]);
                        if (!isAbsolute(executable))
                            throw new Error(
                                `Unresolved ${command} shim; supply --bindings FILE`,
                            );
                        watch(executable);
                    }
                    const output = query(executable, PROBES[command]);
                    if (command === "go" && output.startsWith("{")) {
                        const value = object(JSON.parse(output));
                        data =
                            typeof value.GOROOT === "string"
                                ? {
                                      executable: join(value.GOROOT, "bin/go"),
                                      version: String(value.GOVERSION),
                                      resources: [
                                          value.GOROOT,
                                          join(value.GOROOT, "src"),
                                          join(value.GOROOT, "pkg/include"),
                                      ],
                                  }
                                : value;
                    } else if (
                        ["pnpm", "composer"].includes(command) &&
                        !output.startsWith("{")
                    ) {
                        const version = output.match(
                            /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/,
                        )?.[0];
                        if (!version)
                            throw new Error(
                                `Invalid ${command} version response`,
                            );
                        data = { executable, version, resources: [] };
                        if (
                            command === "pnpm" &&
                            readFileSync(realpathSync(executable))
                                .subarray(0, 2)
                                .toString() === "#!"
                        ) {
                            let current = dirname(realpathSync(executable));
                            while (
                                current !== dirname(current) &&
                                !existsSync(join(current, "package.json"))
                            )
                                current = dirname(current);
                            if (!existsSync(join(current, "package.json")))
                                throw new Error(
                                    "Unrecognized pnpm launcher; supply --bindings FILE",
                                );
                            const packageName = object(
                                JSON.parse(
                                    readFileSync(
                                        join(current, "package.json"),
                                        "utf8",
                                    ),
                                ),
                            ).name;
                            if (
                                typeof packageName !== "string" ||
                                !["pnpm", "corepack", "@pnpm/exe"].includes(
                                    packageName,
                                )
                            )
                                throw new Error(
                                    "Unrecognized pnpm launcher; supply --bindings FILE",
                                );
                            data.resources = [current];
                        }
                    } else {
                        try {
                            data = object(JSON.parse(output));
                        } catch {
                            throw new Error(
                                `Invalid ${command} metadata response`,
                            );
                        }
                    }
                } finally {
                    rmSync(directory, { recursive: true, force: true });
                }
                if (
                    typeof data.executable !== "string" ||
                    typeof data.version !== "string" ||
                    !/^(?:go)?\d+\.\d+(?:\.\d+)?[a-zA-Z0-9.+_-]*$/.test(
                        data.version,
                    ) ||
                    !isAbsolute(data.executable)
                )
                    throw new Error(`Invalid ${command} metadata`);
                if (realpathSync(executable) === realpathSync(data.executable))
                    addFile(executable, true);
                else if (basename(data.executable) !== command)
                    throw new Error(
                        `Cannot expose ${command} from an unresolved launcher; supply --bindings FILE`,
                    );
                addFile(data.executable, true);
                if (
                    !Array.isArray(data.resources) ||
                    data.resources.length > 256 ||
                    data.resources.some(
                        (resource) =>
                            typeof resource !== "string" ||
                            !isAbsolute(resource),
                    )
                )
                    throw new Error(
                        `Invalid ${command} resources (count=${Array.isArray(data.resources) ? data.resources.length : "not-array"}, non-absolute=${Array.isArray(data.resources) ? data.resources.filter((resource: unknown) => typeof resource !== "string" || !isAbsolute(resource)).length : "unknown"})`,
                    );
                const resources: unknown[] = data.resources;
                for (const resource of resources) {
                    if (typeof resource !== "string")
                        throw new Error(`Invalid ${command} resource`);
                    if (statSync(resource).isDirectory())
                        addDirectory(resource);
                    else addFile(resource);
                }
                tools.push({
                    name,
                    command,
                    executable: data.executable,
                    version: data.version,
                    source:
                        candidate === data.executable
                            ? "PATH"
                            : "resolved executable",
                });
            }
            const compact: typeof roots = [];
            for (const entry of roots) {
                if (entry.files === undefined) {
                    if (
                        ![...directories].some(
                            (directory) =>
                                directory !== entry.root &&
                                installationContains(directory, entry.root),
                        )
                    )
                        compact.push(entry);
                    continue;
                }
                const selected = entry.path.length
                    ? entry.files
                    : entry.files.filter(
                          (file) =>
                              ![...directories].some((directory) =>
                                  installationContains(
                                      directory,
                                      join(entry.root, file),
                                  ),
                              ),
                      );
                if (!selected.length) continue;
                const previous = compact.find(
                    (item) =>
                        item.root === entry.root && item.files !== undefined,
                );
                if (previous?.files) {
                    previous.files = [
                        ...new Set([...previous.files, ...selected]),
                    ];
                    previous.path = [
                        ...new Set([...previous.path, ...entry.path]),
                    ];
                } else compact.push({ ...entry, files: selected });
            }
            installations[name] = parseGlobalInstallations(
                { [name]: compact },
                true,
            )[name];
            selectInstallations({ [name]: installations[name] });
        } catch (error) {
            delete installations[name];
            unavailable.push({
                name,
                reason: `${error instanceof Error ? error.message : "Tool discovery failed"}. Use preview/apply --rediscover for stale bindings.`,
            });
        }
    }
    return {
        installations,
        tools,
        unavailable,
        assertUnchanged() {
            for (const [path, previous] of watched) {
                if (
                    !existsSync(path) ||
                    identity(path, previous.permissionsOnly) !== previous.value
                )
                    throw new Error(
                        `Tool installation changed after preview: ${path}`,
                    );
            }
        },
    };
}

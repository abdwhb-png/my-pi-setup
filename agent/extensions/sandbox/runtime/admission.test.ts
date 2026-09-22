import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { SandboxAdmissionReport } from "../../_shared/sandbox-runtime/admission-protocol.ts";
import {
    assertAdmissionMatchesPolicy,
    MAX_ADMISSION_BYTES,
    parseSandboxAdmissionReport,
    readSandboxAdmission,
} from "./admission.ts";
import type { SandboxPolicy } from "./contracts.ts";

const digest = "a".repeat(64);
function receipt(): SandboxAdmissionReport {
    return { schema: 1, runtime: { target: "x86_64-unknown-linux-gnu", version: "test", manifestSha256: digest, component: "shell" }, helperSha256: digest,
        kernelMounts: [{ destination: "/__zerobox/runtime", root: "/bundle/shell", source: "/dev/test", filesystem: "ext4", access: "ro" as const }], mounts: [{ source: "/bundle/components/shell", destination: "/__zerobox/runtime", access: "ro", origin: "runtime" }],
        filesystem: { allowRead: ["/project"], denyRead: [], denyReadGlobs: [], allowWrite: ["/project"], denyWrite: ["/__zerobox"], denyWriteGlobs: [] },
        network: { mode: "deny-all", allow: [], allowHost: [], deny: [], allowLocalBinding: false },
        resources: { unixSockets: [], tcpPublications: [] }, path: ["/__zerobox/runtime/bin"],
        environment: { inherit: [], set: ["PATH", "HOME"], deny: [] }, home: {path: "/home/sandbox", namespace: "lease-private"}, tmp: {path: "/tmp", namespace: "lease-private"}, docker: {mode: "disabled"} };
}

test("admission is returned only after complete EOF with an exact digest", async () => {
    const stream = new PassThrough();
    const result = readSandboxAdmission(stream);
    const bytes = JSON.stringify(receipt());
    stream.write(bytes.slice(0, 100));
    let complete = false;
    void result.then(() => { complete = true; });
    await Bun.sleep(0);
    expect(complete).toBe(false);
    stream.end(bytes.slice(100));
    expect(await result).toEqual({ report: receipt(), sha256: createHash("sha256").update(bytes).digest("hex") });
});

test("missing, oversized and invalid admission reports fail explicitly", async () => {
    for (const bytes of ["", "{}", "x".repeat(MAX_ADMISSION_BYTES + 1), JSON.stringify({...receipt(), mounts: [{source: "/host", destination: "/__zerobox/runtime", access: "rw", origin: "policy"}]}), JSON.stringify({...receipt(), runtime: {...receipt().runtime, target: "aarch64-unknown-linux-gnu"}})]) {
        const stream = new PassThrough();
        const result = readSandboxAdmission(stream);
        stream.end(bytes);
        await expect(result).rejects.toMatchObject({ code: "protocol-error" });
    }
});

test("admission requires read-only runtime mounts observed by the kernel", async () => {
    for (const kernelMounts of [undefined, [], [{ destination: "/__zerobox/runtime", root: "/bundle/components/shell", source: "/dev/test", filesystem: "ext4", access: "rw" }]]) {
        const stream = new PassThrough();
        const result = readSandboxAdmission(stream);
        stream.end(JSON.stringify({ ...receipt(), kernelMounts }));
        await expect(result).rejects.toMatchObject({ code: "protocol-error" });
    }
});

function policyFor(report: SandboxAdmissionReport): SandboxPolicy {
    return {name:"bash-general", strict:true, tmpNamespace:report.tmp.namespace,
        filesystem:report.filesystem, network:report.network, resources:report.resources, docker:report.docker,
        environment:{inherit:[],set:{HOME:report.home.path,PATH:report.path.join(":")},deny:[]}};
}
const pinned = {manifestSha256:digest, helperSha256:digest, version:"test",target:"x86_64-unknown-linux-gnu" as const,component:"shell" as const,shellRoot:"/bundle/components/shell",analysisRoot:"/bundle/components/analysis"};

test("admission rejects mismatched helper identity, redirected runtime and undeclared environment",()=>{
    const original=receipt();
    const policy=policyFor(original);
    for(const report of [
        {...original,helperSha256:"b".repeat(64)},
        {...original,runtime:{...original.runtime,version:"different"}},
        {...original,mounts:[{...original.mounts[0]!,source:"/different-runtime"}]},
        {...original,environment:{...original.environment,set:[...original.environment.set,"HOST_SECRET"]}},
        {...original,environment:{...original.environment,inherit:["HOST_SECRET"]}},
    ]) expect(()=>assertAdmissionMatchesPolicy({report,sha256:digest},policy,pinned)).toThrow();
});

test("resource admission compares object members independently of wire key order",()=>{
    const original=receipt();
    const policy=policyFor(original);
    policy.docker={mode:"full",endpoint:"unix:///run/docker.sock"};
    policy.resources={unixSockets:[],tcpPublications:[{transport:"tcp",scope:"host",listen:"127.0.0.1:8000",target:"127.0.0.1:3000"}]};
    const report:SandboxAdmissionReport={...original,docker:{endpoint:"unix:///run/docker.sock",mode:"full"},resources:{unixSockets:[],tcpPublications:[{target:"127.0.0.1:3000",listen:"127.0.0.1:8000",scope:"host",transport:"tcp"}]}};
    expect(()=>assertAdmissionMatchesPolicy({report,sha256:digest},policy,pinned)).not.toThrow();
});

test("an admission cannot add a policy mount outside the authorized filesystem",()=>{
    const report=receipt();
    report.mounts.push({source:"/outside",destination:"/outside",access:"rw",origin:"policy"});
    expect(()=>assertAdmissionMatchesPolicy({report,sha256:digest},policyFor(report),pinned)).toThrow("mount");
});

test("an internal or runtime label cannot hide an undeclared host mount", () => {
    const original = receipt();
    for (const mount of [
        { source: "/outside", destination: "/outside", access: "rw" as const, origin: "internal" as const },
        { source: "/outside", destination: "/outside", access: "ro" as const, origin: "runtime" as const },
        { source: "/bundle/components/analysis", destination: "/__zerobox/analysis", access: "ro" as const, origin: "runtime" as const },
    ]) {
        const report = { ...original, mounts: [...original.mounts, mount] };
        expect(() => assertAdmissionMatchesPolicy({ report, sha256: digest }, policyFor(original), pinned)).toThrow("mount");
    }
});

test("an authorized loader may need an intermediate alias directory without granting that directory", () => {
    const original = receipt();
    const filesystem = { ...original.filesystem, allowRead: ["/lib64/ld.so", "/usr/lib/x86/ld.so"] };
    const report = { ...original, filesystem, pathAliases: [
        { destination: "/lib64", target: "/usr/lib64", directory: true },
        { destination: "/lib64/ld.so", target: "/usr/lib/x86/ld.so", directory: false },
    ] };
    expect(() => assertAdmissionMatchesPolicy({ report, sha256: digest }, policyFor(report), pinned)).not.toThrow();
    expect(() => assertAdmissionMatchesPolicy({ report: { ...report, pathAliases: [{ destination: "/outside", target: "/usr/lib64", directory: true }] }, sha256: digest }, policyFor(report), pinned)).toThrow("alias");
});

test("an exact authorized Unix socket may be mounted without granting its parent",()=>{
    const original=receipt();const policy=policyFor(original);
    policy.resources={unixSockets:["/run/selected.sock"],tcpPublications:[]};
    const report={...original,resources:policy.resources,mounts:[...original.mounts,{source:"/run/selected.sock",destination:"/run/selected.sock",access:"rw" as const,origin:"policy" as const}]};
    expect(()=>assertAdmissionMatchesPolicy({report,sha256:digest},policy,pinned)).not.toThrow();
    report.mounts[1]={source:"/run",destination:"/run",access:"rw",origin:"policy"};
    expect(()=>assertAdmissionMatchesPolicy({report,sha256:digest},policy,pinned)).toThrow("mount");
});

test("an exact Unix socket may use an empty internal parent view", () => {
    const original = receipt();
    const policy = policyFor(original);
    policy.resources = {
        unixSockets: ["/run/selected.sock"],
        tcpPublications: [],
    };
    const control = {
        source: "/internal/control/root",
        destination: "/__zerobox",
        access: "ro" as const,
        origin: "internal" as const,
    };
    const view = {
        source: "/internal/view-1",
        destination: "/run",
        access: "rw" as const,
        origin: "internal" as const,
    };
    const socket = {
        source: "/run/selected.sock",
        destination: "/run/selected.sock",
        access: "rw" as const,
        origin: "policy" as const,
    };
    const report = {
        ...original,
        resources: policy.resources,
        mounts: [...original.mounts, control, view, socket],
    };
    expect(() =>
        assertAdmissionMatchesPolicy(
            { report, sha256: digest },
            policy,
            pinned,
        ),
    ).not.toThrow();
    expect(() =>
        assertAdmissionMatchesPolicy(
            {
                report: {
                    ...report,
                    mounts: [
                        ...original.mounts,
                        control,
                        { ...view, destination: "/outside" },
                        socket,
                    ],
                },
                sha256: digest,
            },
            policy,
            pinned,
        ),
    ).toThrow("mount");
});

test("engine internal denials may strengthen but never remove submitted denials",()=>{
    const original=receipt();const policy=policyFor(original);
    const strengthened={...original,filesystem:{...original.filesystem,denyWrite:[...original.filesystem.denyWrite,"/bundle"],denyRead:["/internal-work"]}};
    expect(()=>assertAdmissionMatchesPolicy({report:strengthened,sha256:digest},policy,pinned)).not.toThrow();
    const weaker={...original,filesystem:{...original.filesystem,denyWrite:[]}};
    expect(()=>assertAdmissionMatchesPolicy({report:weaker,sha256:digest},policy,pinned)).toThrow("denyWrite");
});

test("engine environment additions are restricted to the admitted network and Docker modes",()=>{
    const original=receipt();const policy=policyFor(original);
    const closed={...original,environment:{...original.environment,set:[...original.environment.set,"CODEX_SANDBOX_NETWORK_DISABLED"]}};
    expect(()=>assertAdmissionMatchesPolicy({report:closed,sha256:digest},policy,pinned)).not.toThrow();
    const proxy={...original,network:{...original.network,mode:"domain-allowlist" as const,allow:["example.com"]},environment:{...original.environment,set:[...original.environment.set,"HTTP_PROXY","NODE_USE_ENV_PROXY"]}};
    expect(()=>assertAdmissionMatchesPolicy({report:proxy,sha256:digest},{...policy,network:proxy.network},pinned)).not.toThrow();
    const docker={...original,docker:{mode:"full" as const,endpoint:"unix:///run/docker.sock"},environment:{...original.environment,set:[...original.environment.set,"DOCKER_HOST"]}};
    expect(()=>assertAdmissionMatchesPolicy({report:docker,sha256:digest},{...policy,docker:docker.docker},pinned)).not.toThrow();
    for(const name of ["HTTP_PROXY","DOCKER_HOST","HOST_SECRET"]){
        const unexpected={...original,environment:{...original.environment,set:[...original.environment.set,name]}};
        expect(()=>assertAdmissionMatchesPolicy({report:unexpected,sha256:digest},policy,pinned)).toThrow("environment");
    }
    const denied={...policy,environment:{...policy.environment,deny:["CODEX_SANDBOX_NETWORK_DISABLED"]}};
    expect(()=>assertAdmissionMatchesPolicy({report:{...closed,environment:{...closed.environment,deny:denied.environment.deny}},sha256:digest},denied,pinned)).toThrow("environment");
});

test("mediated direct admission requires schema two and exact effective ports", () => {
    const original = receipt();
    const network = {
        ...original.network,
        mode: "domain-allowlist" as const,
        allow: ["example.com"],
        mediatedDirectTcp: { ports: [80, 443] },
    };
    const policy = { ...policyFor(original), network };
    const admitted: SandboxAdmissionReport = {
        ...original,
        schema: 2,
        network,
    };

    expect(parseSandboxAdmissionReport(admitted)).toEqual(admitted);
    expect(() =>
        parseSandboxAdmissionReport({ ...admitted, schema: 1 }),
    ).toThrow(/mediated/i);
    expect(() =>
        assertAdmissionMatchesPolicy(
            { report: admitted, sha256: digest },
            policy,
            pinned,
        ),
    ).not.toThrow();
    for (const report of [
        { ...admitted, schema: 1 as const },
        { ...admitted, network: { ...network, mediatedDirectTcp: undefined } },
        {
            ...admitted,
            network: { ...network, mediatedDirectTcp: { ports: [80, 443, 8443] } },
        },
    ])
        expect(() =>
            assertAdmissionMatchesPolicy(
                { report: report as SandboxAdmissionReport, sha256: digest },
                policy,
                pinned,
            ),
        ).toThrow(/schema|mediated|port/i);

    expect(() =>
        assertAdmissionMatchesPolicy(
            { report: admitted, sha256: digest },
            {
                ...policy,
                network: { ...network, mediatedDirectTcp: undefined },
            },
            pinned,
        ),
    ).toThrow(/schema|mediated|port/i);
});

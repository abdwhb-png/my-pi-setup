#!/usr/bin/env python3
"""Offline runtime distribution builder. Run inside the pinned Ubuntu builder."""
import argparse, hashlib, json, os, shutil, struct, subprocess, sys, tempfile
from pathlib import Path

IMAGE = "ubuntu@sha256:a61567bd31828687156d735ea8eb01ba4e37636e225dd6a48ba94136a70d9d61"
NODE = ("node-v24.18.0-linux-x64.tar.xz", "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742")
BUN = ("bun-linux-x64-baseline.zip", "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7")
PACKAGES = ["bash", "coreutils", "findutils", "grep", "sed", "gawk", "diffutils", "tar", "gzip"]

def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()
def fail(message): raise RuntimeError(message)
def load(path): return json.loads(Path(path).read_text())
def checked(root, relative, expected):
    path=(root/relative).resolve()
    if root.resolve() not in path.parents and path != root.resolve(): fail(f"input escapes cache: {relative}")
    if not path.is_file(): fail(f"missing locked input: {relative}")
    if sha(path)!=expected: fail(f"digest mismatch: {relative}")
    return path
def metadata(lock):
    entries=lock.get("metadata")
    if not isinstance(entries,dict): return {}
    root=Path(__file__).resolve().parent
    resolved={}
    for name, item in entries.items():
        if not isinstance(name,str) or not isinstance(item,dict) or not isinstance(item.get("path"),str) or not isinstance(item.get("sha256"),str): fail("invalid durable input metadata")
        resolved[name]=checked(root,item["path"],item["sha256"])
    return resolved
def verify(lock, inputs):
    value=load(lock)
    if value.get("schema")!=1 or value.get("image")!=IMAGE: fail("unexpected Ubuntu builder image")
    for item in value.get("files",[]): checked(inputs,item["path"],item["sha256"])
    durable=metadata(value)
    index=value.get("packageIndex")
    if index:
        package_path=durable.get(index) if isinstance(index,str) else None
        if package_path is None: fail("missing durable package index")
        packages=load(package_path)
        if not isinstance(packages,list): fail("locked package index is not a list")
        for package in packages:
            if not isinstance(package,dict) or not all(isinstance(package.get(key),str) for key in ("file","package","version","sha256")): fail("invalid locked package entry")
            checked(inputs, f"build-inputs/{package['file']}", package["sha256"])
    assets=durable.get("assets")
    if assets:
        declared=load(assets)
        if not isinstance(declared,list) or {(item.get("file"),item.get("sha256")) for item in declared if isinstance(item,dict)} != {NODE,BUN}: fail("unexpected locked runtime archives")
        for item in declared: checked(inputs, f"downloads/{item['file']}", item["sha256"])
    return value,durable
def verify_builder(builder, lock, durable):
    expected={}
    package_index=durable.get(lock["packageIndex"])
    builder_lock=durable.get(lock["builderPackageLock"])
    if package_index is None or builder_lock is None: fail("missing durable builder metadata")
    for package in load(package_index): expected[package["package"]]=package["version"]
    for item in load(builder_lock)["packages"]:
        name, version=item.split("\t",1); expected.setdefault(name,version)
    for package, version in expected.items():
        result=subprocess.run(["dpkg-query", "-W", "-f=${Version}", package], cwd=builder, capture_output=True, text=True)
        if result.returncode != 0 or result.stdout.strip() != version: fail(f"builder package mismatch: {package}")
def run(*args, cwd=None): return subprocess.check_output(args, text=True, cwd=cwd).strip()
def copy(source, target): target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(source,target)
def elf_dependencies(binary):
    result=subprocess.run(["ldd",str(binary)],capture_output=True,text=True)
    if result.returncode and "statically linked" not in result.stdout and "not a dynamic executable" not in result.stderr: fail(result.stdout+result.stderr)
    import re
    return [Path(x).resolve() for x in re.findall(r"(?:=>\s+)?(/[^\s()]+)",result.stdout) if Path(x).is_file()]
def elf(path):
    return path.is_file() and not path.is_symlink() and path.read_bytes()[:4] == b"\x7fELF"
def set_private_interpreter(path,prefix):
    data=bytearray(path.read_bytes())
    if data[:6] != b"\x7fELF\x02\x01": fail(f"unsupported executable ELF format: {path}")
    program_offset=struct.unpack_from("<Q",data,32)[0]
    program_size=struct.unpack_from("<H",data,54)[0]
    program_count=struct.unpack_from("<H",data,56)[0]
    requested=f"{prefix}/ld.so".encode()+b"\0"
    for index in range(program_count):
        header=program_offset+index*program_size
        if header+56 > len(data): fail(f"malformed executable program header: {path}")
        if struct.unpack_from("<I",data,header)[0] != 3: continue
        offset=struct.unpack_from("<Q",data,header+8)[0]
        size=struct.unpack_from("<Q",data,header+32)[0]
        if offset+size > len(data) or len(requested) > size: fail(f"private interpreter path does not fit executable: {path}")
        data[offset:offset+size]=requested.ljust(size,b"\0")
        path.write_bytes(data)
        return True
    return False
def relocate(root,prefix):
    libraries={}
    for binary in root.rglob("*"):
        if elf(binary): libraries.update({path.name:path for path in elf_dependencies(binary)})
    copied=set()
    while copied != set(libraries):
        for name, source in list(libraries.items()):
            if name in copied: continue
            copied.add(name); copy(source,root/"lib"/name)
            libraries.update({path.name:path for path in elf_dependencies(source)})
    import re
    for name in sorted(copied):
        library=root/"lib"/name
        dynamic=run("readelf","-d",str(library))
        sonames=re.findall(r"\(SONAME\).*?\[(.*?)\]",dynamic)
        for soname in sonames:
            if not soname or Path(soname).name != soname: fail(f"invalid library SONAME: {name}")
            alias=root/"lib"/soname
            if alias == library: continue
            if alias.exists() or alias.is_symlink():
                if sha(alias)!=sha(library): fail(f"conflicting library SONAME: {soname}")
            else: alias.symlink_to(name)
    loaders=[path for path in (root/"lib").iterdir() if path.name.startswith("ld-linux-")]
    if len(loaders) != 1: fail("runtime requires exactly one private dynamic loader")
    copy(loaders[0],root/"ld.so")
    for path in root.rglob("*"):
        if not elf(path): continue
        if path.parent == root/"bin":
            if set_private_interpreter(path,prefix):
                # DT_RPATH is transitive, so glibc and gawk extension modules can retain
                # their original program headers while resolving only private libraries.
                subprocess.run(["patchelf","--force-rpath","--set-rpath",f"{prefix}/lib",str(path)],check=True)
        path.chmod(0o555)
def copy_analysis_closure(source_root, target_root):
    copied={}; versions={}
    def locate(name, origin):
        for directory in [origin,*origin.parents]:
            candidate=(directory/name) if directory.name == "node_modules" else (directory/"node_modules"/name)
            if (candidate/"package.json").is_file(): return candidate.resolve()
        fail(f"missing locked Analysis dependency: {name}")
    def package(name, origin, consumer):
        source=locate(name,origin); metadata=load(source/"package.json"); version=metadata.get("version")
        if not isinstance(version,str): fail(f"Analysis dependency has no version: {name}")
        target=(consumer if name in versions and versions[name]!=version else target_root)/"node_modules"/name
        key=target.relative_to(target_root).as_posix()
        if key in copied: return
        versions.setdefault(name,version); copied[key]={"name":name,"version":version,"packageJsonSha256":sha(source/"package.json")}
        # Resolve each declared dependency below instead of copying an installer's
        # nested node_modules tree into the owning package's locked content.
        target.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(source,target,symlinks=False,dirs_exist_ok=True,ignore=shutil.ignore_patterns(".git", "node_modules"))
        copied[key]["treeSha256"]=hashlib.sha256(json.dumps(entries(target),sort_keys=True,separators=(",",":")).encode()).hexdigest()
        for dependency in metadata.get("dependencies",{}): package(dependency,source,target)
        for dependency in metadata.get("optionalDependencies",{}):
            try: locate(dependency,source)
            except RuntimeError: continue
            package(dependency,source,target)
    # QuickJS loads its TypeScript peer at execution time. It is part of the
    # private worker closure even though the package marks the peer optional.
    for name in ["@bsull/eryx","@jitl/quickjs-ng-wasmfile-release-sync","@sebastianwessel/quickjs","typescript"]: package(name,source_root/"extensions/sandbox",target_root)
    return copied
def entries(root):
    result=[]
    for path in sorted(root.rglob("*")):
        if path.is_dir(): continue
        relative=path.relative_to(root).as_posix()
        if path.is_symlink(): result.append({"path":relative,"symlink":os.readlink(path)})
        else: result.append({"path":relative,"sha256":sha(path)})
    return result
def check_analysis_inputs(closure, durable):
    expected_path=durable.get("analysis")
    if expected_path is None: fail("missing locked Analysis package closure")
    expected=load(expected_path)
    different=sorted(key for key in set(expected)|set(closure) if expected.get(key)!=closure.get(key))
    if different: fail(f"Analysis package inputs differ from the locked closure: {', '.join(different)}")
def seal_tree(root):
    for path in [root,*root.rglob("*")]:
        if path.is_symlink(): continue
        if path.is_dir(): path.chmod(0o755)
        elif path.is_file(): path.chmod(0o555 if path.stat().st_mode & 0o111 else 0o444)
        else: fail(f"unsupported runtime object: {path}")
def build(args):
    inputs=Path(args.input_root); lock,durable=verify(args.lock,inputs)
    out=Path(args.output); builder=Path(args.builder_root); agent=Path(args.agent_root)
    if out.exists(): fail(f"refuse to overwrite output: {out}")
    if not (builder/"usr/bin/dpkg-query").exists() and builder != Path("/"): fail("builder root lacks dpkg-query")
    verify_builder(builder, lock, durable)
    shell=out/"components/shell"; analysis=out/"components/analysis"
    for package in PACKAGES:
        files=run("dpkg-query","-L",package).splitlines()
        for name in files:
            source=builder/name.lstrip("/")
            if source.is_file() and os.access(source,os.X_OK) and source.parent.as_posix().endswith("/bin"): copy(source,shell/"bin"/source.name)
            elif source.is_file() and (("/gawk/" in name and name.endswith(".so")) or name.startswith("/usr/share/awk/")): copy(source,shell/name.removeprefix("/usr/"))
        license=builder/"usr/share/doc"/package/"copyright"
        if license.is_file(): copy(license,shell/"licenses"/package/"copyright")
    (shell/"bin/sh").symlink_to("bash"); (shell/"bin/awk").symlink_to("gawk")
    relocate(shell,"/__zerobox/runtime")
    import tarfile, zipfile
    with tarfile.open(inputs/"downloads"/NODE[0]) as archive:
        for source,target in [("node-v24.18.0-linux-x64/bin/node",analysis/"bin/node"),("node-v24.18.0-linux-x64/LICENSE",analysis/"licenses/node-LICENSE")]:
            target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(archive.extractfile(source).read())
    with zipfile.ZipFile(inputs/"downloads"/BUN[0]) as archive:
        target=analysis/"bin/bun"; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(archive.read("bun-linux-x64-baseline/bun"))
    copy(builder/"usr/bin/prlimit",analysis/"bin/prlimit")
    for item in (analysis/"bin").iterdir(): item.chmod(0o755)
    workers=analysis/"workers"; workers.mkdir(parents=True)
    for name in ["python-worker.mjs","eryx-loader.mjs"]: copy(agent/"extensions/sandbox/analysis"/name,workers/name)
    subprocess.run([str(analysis/"bin/bun"),"build",str(agent/"extensions/sandbox/analysis/quickjs-worker.ts"),"--outfile",str(workers/"quickjs-worker.js"),"--target","bun","--packages=external"],check=True)
    closure=copy_analysis_closure(agent,analysis)
    check_analysis_inputs(closure,durable)
    relocate(analysis,"/__zerobox/analysis")
    engine=Path(args.engine); helper=Path(args.helper)
    if not engine.is_file() or not helper.is_file() or helper.is_symlink(): fail("engine and static helper must be regular files")
    if "INTERP" in run("readelf","-l",helper): fail("static helper has a dynamic interpreter")
    engine_sha=sha(engine); helper_sha=sha(helper)
    engine_provenance=load(args.engine_provenance)
    if engine_provenance.get("binarySha256") != engine_sha: fail("engine provenance does not match supplied engine")
    version_output=run(str(engine),"--version")
    if not version_output.startswith("zerobox ") or "\n" in version_output: fail("supplied engine did not report a zerobox version")
    engine_version=version_output.removeprefix("zerobox ")
    if not engine_version or engine_provenance.get("version") != engine_version: fail("engine provenance does not match supplied engine version")
    copy(engine,out/"bin/zerobox")
    helper_target=shell/"libexec/zerobox-linux-sandbox"
    copy(helper,helper_target)
    (out/"bin/zerobox").chmod(0o555); helper_target.chmod(0o555)
    manifest={"schema":1,"version":args.version,"target":"x86_64-unknown-linux-gnu","helper":{"path":"components/shell/libexec/zerobox-linux-sandbox","sha256":sha(helper_target)},"components":{"shell":{"root":"components/shell","files":entries(shell)},"analysis":{"root":"components/analysis","files":entries(analysis)}}}
    (out/"manifest.json").write_text(json.dumps(manifest,sort_keys=True,separators=(",",":"))+"\n")
    candidate_provenance={**engine_provenance,"version":engine_version,"runtimeVersion":args.version,"binarySha256":engine_sha,"helperSha256":helper_sha,"runtimeManifestSha256":sha(out/"manifest.json"),"inputs":{"builderImage":lock["image"],"inputLockSha256":sha(args.lock),"metadata":lock["metadata"],"packages":load(durable[lock["packageIndex"]]),"builderPackages":load(durable[lock["builderPackageLock"]])["packages"],"archives":load(durable["assets"]),"quickjsWorkerSha256":sha(agent/"extensions/sandbox/analysis/quickjs-worker.ts"),"analysisClosure":closure}}
    (out/"provenance.json").write_text(json.dumps(candidate_provenance,sort_keys=True,indent=2)+"\n")
    seal_tree(out)
def main():
    parser=argparse.ArgumentParser(); sub=parser.add_subparsers(dest="command",required=True)
    verify_parser=sub.add_parser("verify-inputs"); verify_parser.add_argument("--lock",required=True); verify_parser.add_argument("--input-root",required=True)
    analysis_parser=sub.add_parser("verify-analysis-inputs"); analysis_parser.add_argument("--lock",required=True); analysis_parser.add_argument("--agent-root",required=True)
    assemble=sub.add_parser("assemble");
    for name in ["lock","input-root","builder-root","agent-root","engine","helper","engine-provenance","output","version"]: assemble.add_argument("--"+name,required=True)
    args=parser.parse_args()
    try:
        if args.command=="verify-inputs": verify(Path(args.lock),Path(args.input_root))
        elif args.command=="verify-analysis-inputs":
            with tempfile.TemporaryDirectory(prefix="pi-analysis-inputs-") as directory:
                closure=copy_analysis_closure(Path(args.agent_root).resolve(),Path(directory))
                check_analysis_inputs(closure,metadata(load(args.lock)))
                print(f"Verified {len(closure)} locked Analysis packages")
        else: build(args)
    except Exception as error: print(f"runtime distribution failed: {error}",file=sys.stderr); return 1
    return 0
if __name__=="__main__": sys.exit(main())

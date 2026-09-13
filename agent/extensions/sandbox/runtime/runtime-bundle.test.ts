import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePrivateRuntime, readPrivateRuntimeEntry } from "./runtime-bundle.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
 const parent=await mkdtemp(join(tmpdir(), "bundle-"));
 const root=join(parent,"runtimes/zerobox/test");
 for (const dir of ["bin", "helper", "components/shell/bin", "components/analysis/bin"]) await mkdir(join(root,dir),{recursive:true});
 const files={"bin/zerobox":"engine", "helper/zerobox-linux-sandbox":"helper", "components/shell/bin/bash":"bash", "components/shell/bin/env":"env", "components/analysis/bin/node":"node"};
 for (const [path,content] of Object.entries(files)) await writeFile(join(root,path),content,{mode:0o700});
 const manifest={schema:1,target:"x86_64-unknown-linux-gnu",version:"test",helper:{path:"helper/zerobox-linux-sandbox",sha256:sha("helper")},components:{shell:{root:"components/shell",files:[{path:"bin/bash",sha256:sha("bash")},{path:"bin/env",sha256:sha("env")}]},analysis:{root:"components/analysis",files:[{path:"bin/node",sha256:sha("node")}]}}};
 await writeFile(join(root,"manifest.json"),JSON.stringify(manifest));
 await mkdir(join(parent,"bin"));
 const entry=join(parent,"bin/zerobox"); await symlink(join(root,"bin/zerobox"),entry);
 return {parent,root,entry,manifest};
}
test("a managed entry pins the real bundle and validates its complete distribution",async()=>{
 const f=await fixture();try {
  const runtime=await resolvePrivateRuntime({binaryPath:f.entry,expectedBinarySha256:sha("engine")});
  expect(runtime.root).toBe(f.root);
  expect(runtime.binaryPath).toBe(join(f.root,"bin/zerobox"));
  expect(runtime.manifestSha256).toBe(sha(JSON.stringify(f.manifest)));
  expect(runtime.components.shell.root).toBe(join(f.root,"components/shell"));
 }finally{await rm(f.parent,{recursive:true,force:true});}
});
test("tampering, undeclared files, missing libraries and foreign releases block admission",async()=>{
 for(const change of [async(f:Awaited<ReturnType<typeof fixture>>)=>writeFile(join(f.root,"components/shell/bin/bash"),"changed"), async(f:Awaited<ReturnType<typeof fixture>>)=>writeFile(join(f.root,"components/shell/bin/extra"),"extra"), async(f:Awaited<ReturnType<typeof fixture>>)=>rm(join(f.root,"components/shell/bin/env")),async(f:Awaited<ReturnType<typeof fixture>>)=>writeFile(join(f.root,"manifest.json"),JSON.stringify({...f.manifest,target:"aarch64-unknown-linux-gnu"}))]) {
  const f=await fixture();try{await change(f);await expect(resolvePrivateRuntime({binaryPath:f.entry,expectedBinarySha256:sha("engine")})).rejects.toMatchObject({code:"provenance-mismatch"});}finally{await rm(f.parent,{recursive:true,force:true});}
 }
});
test("pins a managed entry with its adjacent provenance and rejects unsafe release identifiers",async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,"provenance.json"),JSON.stringify({version:"engine-test",binarySha256:sha("engine"),runtimeManifestSha256:sha(JSON.stringify(f.manifest)),helperSha256:sha("helper")}),{mode:0o600});
  const pinned=await readPrivateRuntimeEntry(f.entry,new URL("file:///missing-legacy-provenance"));
  expect(pinned.binaryPath).toBe(join(f.root,"bin/zerobox"));expect(pinned.provenance.version).toBe("engine-test");
  await rm(f.entry);await symlink("/tmp/unrelated-engine",f.entry);
  expect(await resolvePrivateRuntime({binaryPath:pinned.binaryPath,expectedBinarySha256:pinned.provenance.binarySha256})).toMatchObject({version:"test"});
  await writeFile(join(f.root,"manifest.json"),JSON.stringify({...f.manifest,version:"../../escape"}));
  await expect(resolvePrivateRuntime({binaryPath:pinned.binaryPath,expectedBinarySha256:sha("engine")})).rejects.toMatchObject({code:"provenance-mismatch"});
 }finally{await rm(f.parent,{recursive:true,force:true});}
});

test("distribution metadata rejects unknown components and redirected manifest files",async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,"manifest.json"),JSON.stringify({...f.manifest,components:{...f.manifest.components,extra:{root:"components/analysis",files:[]}}}));
  await expect(resolvePrivateRuntime({binaryPath:f.entry,expectedBinarySha256:sha("engine")})).rejects.toMatchObject({code:"provenance-mismatch"});
  const manifestPath=join(f.root,"manifest.json");await rm(manifestPath);
  const external=join(f.parent,"external-manifest");await writeFile(external,JSON.stringify(f.manifest));await symlink(external,manifestPath);
  await writeFile(join(f.root,"provenance.json"),JSON.stringify({version:"engine-test",binarySha256:sha("engine"),runtimeManifestSha256:sha(JSON.stringify(f.manifest)),helperSha256:sha("helper")}),{mode:0o600});
  await expect(readPrivateRuntimeEntry(f.entry,new URL("file:///unused"))).rejects.toMatchObject({code:"provenance-mismatch"});
 }finally{await rm(f.parent,{recursive:true,force:true});}
});

import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
    const request=JSON.parse(line);if(request.id===undefined)continue;
    let result;
    if(request.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'env-fixture',version:'1'}};
    else if(request.method==='tools/list')result={tools:[{name:'environment',description:'Check inherited environment',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
    else if(request.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({braced:process.env.FIXTURE_BRACED==='fixture-parent',bare:process.env.FIXTURE_BARE==='fixture-parent',inherited:process.env.PI_MCP_FIXTURE_PARENT==='fixture-parent'})}]};
    else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');continue;}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}

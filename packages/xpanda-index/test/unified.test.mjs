import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sample=resolve(root,'packages/xpanda-core/test/resources/class.abc');
const server=resolve(root,'packages/xpanda-index/src/unified-mcp.mjs');

async function connect(args){
 const client=new Client({name:'unified-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[server,...args],stderr:'pipe'});
 try{await client.connect(transport);return client;}
 catch(error){await client.close();throw error;}
}
async function call(client,name,args){
 const result=await client.callTool({name,arguments:args});
 assert.notEqual(result.isError,true,JSON.stringify(result));
 return result.structuredContent??JSON.parse(result.content[0].text);
}

test('one MCP connection supports existing live decompilation, export and persistent xrefs',async()=>{
 const temp=await fs.mkdtemp(resolve(tmpdir(),'unified-mcp-'));let client;
 try{
  const database=resolve(temp,'app.db');
  const built=spawnSync(process.execPath,[resolve(root,'packages/xpanda-index/src/code-index.mjs'),'build',sample,'--database',database],{encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  client=await connect(['--database',database]);
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  assert.equal(names.length,20);
  for(const name of ['abc_load','abc_decompile_class','abc_export','hap_resources','code_index_methods','code_index_xrefs'])assert.ok(names.includes(name));
  const loaded=await call(client,'abc_load',{path:sample});
  const classes=await call(client,'abc_list_classes',{fileId:loaded.fileId});
  const record=classes.classes.find(row=>row.methods>0)?.name??loaded.classesPreview[0];
  const detail=await call(client,'abc_get_class',{fileId:loaded.fileId,className:record});
  const disassembly=await client.callTool({name:'abc_disassemble_method',arguments:{fileId:loaded.fileId,className:record,methodName:detail.methods.find(row=>row.hasCode).name}});
  assert.notEqual(disassembly.isError,true);
  await call(client,'abc_search_strings',{fileId:loaded.fileId,pattern:'foo'});
  const decompiled=await client.callTool({name:'abc_decompile_class',arguments:{fileId:loaded.fileId,className:record,simplify:false}});
  assert.notEqual(decompiled.isError,true);
  assert.match(decompiled.content[0].text,/xpanda-mcp class=/);
  await call(client,'abc_export',{fileId:loaded.fileId,outDir:resolve(temp,'exported'),simplify:false});
  assert.ok((await fs.readdir(resolve(temp,'exported'))).length>0);
  const listing=await call(client,'code_index_list',{}),index_id=listing.indexes[0].index_id;
  const stats=await call(client,'code_index_stats',{index_id});
  assert.equal(stats.counts.methods,4);
  const refs=await call(client,'code_index_xrefs',{index_id,entry:'class.abc',target_kind:'method',target_offset:321});
  assert.ok(refs.rows.some(row=>row.relation==='class_constructor'));
  await call(client,'abc_close',{fileId:loaded.fileId});
  const hap=await call(client,'abc_load',{path:resolve(root,'packages/xpanda-core/test/resources/zhihupp0.59.hap')});
  const entry=await call(client,'hap_read_abc',{fileId:hap.fileId,entry:hap.abcEntries[0].name});
  assert.ok(entry.classCount>0);
  const resources=await call(client,'hap_resources',{fileId:hap.fileId,limit:1});
  assert.equal(resources.items.length,1);
  await call(client,'abc_close',{fileId:entry.abcFileId});
  await call(client,'abc_close',{fileId:hap.fileId});
 }finally{await client?.close();await fs.rm(temp,{recursive:true,force:true});}
});

test('read-only mode advertises only the ten original index tools',async()=>{
 let client;
 try{
  client=await connect(['--read-only']);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,10);
  assert.ok(tools.every(tool=>tool.name.startsWith('code_index_')&&tool.annotations.readOnlyHint));
  const denied=await client.callTool({name:'abc_export',arguments:{fileId:'x',outDir:'/tmp/unused'}});
  assert.equal(denied.isError,true);
 }finally{await client?.close();}
});

import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

const sqlite=await import('node:sqlite').catch(error=>{if(error.code==='ERR_UNKNOWN_BUILTIN_MODULE')return null;throw error;});
const {DatabaseSync}=sqlite??{};
const {SCHEMA,INDEX_VERSION}=sqlite?await import('../src/code-index-db.mjs'):{};
const test=(name,fn)=>nodeTest(name,{skip:!sqlite,timeout:15000},fn);
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(){
 const parent=await fs.mkdtemp(resolve(tmpdir(),'hap-mcp-')),root=resolve(parent,'allowed'),session=resolve(root,'fixture');
 const database=resolve(session,'indexes/code-index.db');await fs.mkdir(dirname(database),{recursive:true});
 const inventory=JSON.stringify({sha256:'input-fixture',files:[]});await fs.writeFile(resolve(session,'inventory.json'),inventory);
 const db=new DatabaseSync(database);
 try{
  db.exec(SCHEMA);
  for(const [key,value] of Object.entries({schema_version:INDEX_VERSION,artifact_sha256:'input-fixture',inventory_sha256:hash(inventory),call_graph:'not_built'}))db.prepare('INSERT INTO metadata VALUES (?,?)').run(key,JSON.stringify(value));
  db.prepare('INSERT INTO entries VALUES (?,?)').run('app.abc','abc-fixture');
  db.prepare('INSERT INTO classes(entry,record,offset) VALUES (?,?,?)').run('app.abc','LExample;',10);
  const instructions=Array.from({length:5},(_,i)=>({block:'entry',text:`${i}: return`,catch_by:[]}));
  db.prepare('INSERT INTO methods VALUES (?,?,?,?,?,?,?,?,?,?)').run('app.abc',10,'LExample;','run',12,20,5,5,null,JSON.stringify(instructions));
  db.prepare('INSERT INTO xref_targets VALUES (?,?,?,?,?,?)').run('app.abc','string',100,'needle 0',null,null);
  db.prepare('INSERT INTO xrefs(entry,source_class_offset,source_method_offset,instruction_index,pc,block,opcode,operand_path,relation,resolution,target_kind,target_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('app.abc',10,12,0,0,'entry','lda.str','param[0]','string_operand','exact_operand','string',100);
  const source='class Example {\n run() { return "index needle"; }\n}';
  const inserted=db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?)').run('decompiled/Example.js','app.abc','LExample;',hash(source),source,'[]');
  db.prepare('INSERT INTO sources_fts(rowid,content) VALUES (?,?)').run(inserted.lastInsertRowid,source);
  for(let i=0;i<20;i++)db.prepare('INSERT INTO strings VALUES (?,?,?)').run('app.abc',100+i,'needle '+i+' '+ 'x'.repeat(1500));
 }finally{db.close();}
 return {parent,root,session,database,inventory};
}

async function connect(args){
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve(here,'../src/code-index-mcp.mjs'),...args],stderr:'pipe'});
 const client=new Client({name:'code-index-integration-test',version:'1.0.0'});
 try{await client.connect(transport);return {client,transport};}
 catch(error){await transport.close();throw error;}
}

async function firstIndex(client){
 const response=await client.callTool({name:'code_index_list',arguments:{}});
 assert.equal(response.isError,undefined);
 return response.structuredContent.indexes[0].index_id;
}

test('real stdio MCP advertises readonly tools and queries persisted code',async()=>{
 const f=await fixture();let connection;
 try{
  const before=hash(await fs.readFile(f.database));
  connection=await connect(['--root',f.root]);const {client}=connection;
  const tools=(await client.listTools()).tools;
  assert.deepEqual(tools.map(tool=>tool.name).sort(),['code_index_list','code_index_stats','code_index_classes','code_index_methods','code_index_strings','code_index_search','code_index_method','code_index_source','code_index_xrefs','code_index_uses'].sort());
  assert.ok(tools.every(tool=>tool.annotations.readOnlyHint===true&&tool.annotations.destructiveHint===false));
  const index_id=await firstIndex(client);
  const stats=await client.callTool({name:'code_index_stats',arguments:{index_id}});
  assert.equal(stats.structuredContent.counts.methods,1);
  assert.deepEqual(JSON.parse(stats.content[0].text),stats.structuredContent);
  for(const [name,query] of [['code_index_classes','Example'],['code_index_methods','run'],['code_index_strings','needle'],['code_index_search','index needle']]){
   const result=await client.callTool({name,arguments:{index_id,query,limit:2}});
   assert.equal(result.isError,undefined);assert.ok(result.structuredContent.rows.length>0);
  }
  const method=await client.callTool({name:'code_index_method',arguments:{index_id,record:'LExample;',name:'run',entry:'app.abc',class_offset:10,limit:2,offset:1}});
  assert.equal(method.structuredContent.instructions[0].text,'1: return');
  assert.equal(method.structuredContent.next_offset,3);
  const source=await client.callTool({name:'code_index_source',arguments:{index_id,file:'decompiled/Example.js',limit:1,offset:1}});
  assert.equal(source.structuredContent.lines[0].line,2);
  const incoming=await client.callTool({name:'code_index_xrefs',arguments:{index_id,entry:'app.abc',target_kind:'string',target_offset:100,limit:1}});
  assert.equal(incoming.isError,undefined);assert.equal(incoming.structuredContent.rows[0].source_method_offset,12);
  const outgoing=await client.callTool({name:'code_index_uses',arguments:{index_id,entry:'app.abc',class_offset:10,method_offset:12}});
  assert.equal(outgoing.isError,undefined);assert.equal(outgoing.structuredContent.rows[0].target_offset,100);
  assert.equal(hash(await fs.readFile(f.database)),before);
 }finally{await connection?.client.close();await fs.rm(f.parent,{recursive:true,force:true});}
});

test('MCP rejects escaping indexes and invalid arguments without losing the connection',async()=>{
 const f=await fixture();let connection;
 try{
  const outside=resolve(f.parent,'outside.db');await fs.copyFile(f.database,outside);
  await fs.mkdir(resolve(f.root,'escape/indexes'),{recursive:true});await fs.symlink(outside,resolve(f.root,'escape/indexes/code-index.db'));
  connection=await connect(['--root',f.root]);const {client}=connection,index_id=await firstIndex(client);
  const listing=await client.callTool({name:'code_index_list',arguments:{}});assert.equal(listing.structuredContent.indexes.length,1);
  for(const [name,args] of [
   ['code_index_stats',{index_id:'../../outside.db'}],
   ['code_index_methods',{index_id,limit:201}],
   ['code_index_methods',{index_id,offset:-1}],
   ['code_index_source',{index_id,file:'../../secret'}],
   ['code_index_stats',{index_id,path:outside}],
   ['code_index_xrefs',{index_id,entry:'app.abc',target_kind:'string',target_offset:-1}],
   ['code_index_xrefs',{index_id,entry:'app.abc',target_kind:'method; DROP TABLE methods',target_offset:100}],
   ['code_index_uses',{index_id,entry:'app.abc',class_offset:10,method_offset:99}],
  ]){const response=await client.callTool({name,arguments:args});assert.equal(response.isError,true);}
  assert.equal((await client.callTool({name:'code_index_stats',arguments:{index_id}})).structuredContent.counts.methods,1);
 }finally{await connection?.client.close();await fs.rm(f.parent,{recursive:true,force:true});}
});

test('long-lived MCP connections detect stale inventory and atomic database replacement',async()=>{
 const f=await fixture();let connection;
 try{
  connection=await connect(['--root',f.root]);const {client}=connection,index_id=await firstIndex(client);
  await fs.writeFile(resolve(f.session,'inventory.json'),f.inventory+' ');
  const stale=await client.callTool({name:'code_index_stats',arguments:{index_id}});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/stale/i);
  await fs.writeFile(resolve(f.session,'inventory.json'),f.inventory);
  const replacement=resolve(f.parent,'replacement.db');await fs.copyFile(f.database,replacement);
  const db=new DatabaseSync(replacement);try{db.prepare('INSERT INTO metadata VALUES (?,?)').run('revision','2');}finally{db.close();}
  await fs.rename(replacement,f.database);
  const result=await client.callTool({name:'code_index_stats',arguments:{index_id}});assert.equal(result.structuredContent.metadata.revision,2);
 }finally{await connection?.client.close();await fs.rm(f.parent,{recursive:true,force:true});}
});

test('MCP preserves valid JSON and a continuation offset within the response budget',async()=>{
 const f=await fixture();let connection;
 try{
  connection=await connect(['--database',f.database,'--max-output-chars','4096']);const {client}=connection,index_id=await firstIndex(client);
  const result=await client.callTool({name:'code_index_strings',arguments:{index_id,query:'needle',limit:20}});
  assert.equal(result.isError,undefined);assert.ok(result.content[0].text.length<=4096);
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  assert.ok(result.structuredContent.rows.length<20);assert.equal(result.structuredContent.next_offset,result.structuredContent.rows.length);
 }finally{await connection?.client.close();await fs.rm(f.parent,{recursive:true,force:true});}
});

test('parallel Agent calls across more indexes than the connection cache all complete',async()=>{
 const f=await fixture();let connection;
 try{
  for(let i=0;i<7;i++){
   const session=resolve(f.root,'peer-'+i);await fs.mkdir(resolve(session,'indexes'),{recursive:true});
   await fs.copyFile(f.database,resolve(session,'indexes/code-index.db'));
   await fs.writeFile(resolve(session,'inventory.json'),f.inventory);
  }
  connection=await connect(['--root',f.root]);const {client}=connection;
  const listing=await client.callTool({name:'code_index_list',arguments:{}});
  const results=await Promise.all(listing.structuredContent.indexes.map(index=>client.callTool({name:'code_index_stats',arguments:{index_id:index.index_id}})));
  assert.deepEqual(results.filter(result=>result.isError).map(result=>result.content),[]);
  assert.ok(results.every(result=>result.structuredContent.counts.methods===1));
 }finally{await connection?.client.close();await fs.rm(f.parent,{recursive:true,force:true});}
});

test('legacy indexes keep old tools available and return a rebuild instruction for xrefs',async()=>{
 const f=await fixture();let connection;
 try{
  const db=new DatabaseSync(f.database);
  db.exec('DROP TABLE xrefs; DROP TABLE xref_targets');
  db.prepare('UPDATE metadata SET value=? WHERE key=?').run('"1"','schema_version');db.close();
  connection=await connect(['--database',f.database]);const {client}=connection,index_id=await firstIndex(client);
  const refs=await client.callTool({name:'code_index_xrefs',arguments:{index_id,entry:'app.abc',target_kind:'string',target_offset:100}});
  assert.equal(refs.isError,true);assert.match(refs.content[0].text,/rebuild/i);
  const methods=await client.callTool({name:'code_index_methods',arguments:{index_id,query:'run'}});
  assert.equal(methods.isError,undefined);assert.equal(methods.structuredContent.rows.length,1);
 }finally{await connection?.client.close();await fs.rm(f.parent,{recursive:true,force:true});}
});

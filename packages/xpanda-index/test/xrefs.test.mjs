import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const sqlite=await import('node:sqlite').catch(error=>{if(error.code==='ERR_UNKNOWN_BUILTIN_MODULE')return null;throw error;});
const {DatabaseSync}=sqlite??{};
const {SCHEMA,INDEX_VERSION,openIndex,queryIndex}=sqlite?await import('../src/code-index-db.mjs'):{};
const test=(name,fn)=>nodeTest(name,{skip:!sqlite},fn);
const here=dirname(fileURLToPath(import.meta.url)),workspace=resolve(here,'../../..');

test('xref queries use ABC offsets, preserve sites and keep dynamic calls unresolved',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(SCHEMA);
  for(const [key,value] of Object.entries({schema_version:INDEX_VERSION,artifact_sha256:'fixture'}))db.prepare('INSERT INTO metadata VALUES (?,?)').run(key,JSON.stringify(value));
  for(const entry of ['a.abc','b.abc']){
   db.prepare('INSERT INTO entries VALUES (?,?)').run(entry,'sha');
   db.prepare('INSERT INTO classes(entry,record,offset) VALUES (?,?,?)').run(entry,'LExample;',10);
   for(const offset of [12,14])db.prepare('INSERT INTO methods VALUES (?,?,?,?,?,?,?,?,?,?)').run(entry,10,'LExample;','same',offset,20,5,1,null,'[]');
   db.prepare('INSERT INTO xref_targets VALUES (?,?,?,?,?,?)').run(entry,'method',14,'same','LExample;',10);
   db.prepare('INSERT INTO xrefs(entry,source_class_offset,source_method_offset,instruction_index,pc,block,opcode,operand_path,relation,resolution,target_kind,target_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(entry,10,12,0,3,'entry','definemethod','param[1]','function_definition','exact_operand','method',14);
   db.prepare('INSERT INTO xrefs(entry,source_class_offset,source_method_offset,instruction_index,pc,block,opcode,operand_path,relation,resolution,target_kind,target_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(entry,10,12,1,9,'entry','definemethod','param[1]','function_definition','exact_operand','method',14);
  }
  const options={entry:'a.abc','class-offset':10,'method-offset':12};
  const uses=queryIndex(db,'uses',[],options);
  assert.equal(uses.method.offset,12);assert.equal(uses.rows.length,2);
  assert.equal(uses.rows[0].target_offset,14);assert.equal(uses.rows[0].relation,'function_definition');
  const incoming=queryIndex(db,'xrefs',['method','14'],{entry:'a.abc'});
  assert.equal(incoming.target.name,'same');assert.equal(incoming.rows.length,2);
  assert.equal(incoming.rows[0].source_method_offset,12);assert.equal(incoming.rows[0].pc,3);
  assert.equal(queryIndex(db,'xrefs',['method','14'],{entry:'a.abc',limit:1,offset:1}).rows[0].pc,9);
  assert.equal(queryIndex(db,'xrefs',['method','12'],{entry:'a.abc'}).rows.length,0);
  assert.throws(()=>queryIndex(db,'xrefs',['method','14']),/entry/);
  assert.throws(()=>queryIndex(db,'xrefs',["method' OR 1=1 --",'14'],{entry:'a.abc'}),/kind/);
  assert.throws(()=>queryIndex(db,'uses',[],{...options,'method-offset':99}),/not found/);
  assert.throws(()=>queryIndex(db,'uses',[],{...options,relation:'bogus'}),/relation/);
  assert.deepEqual(queryIndex(db,'uses',[],{...options,relation:'dynamic_call'}).rows,[]);
 }finally{db.close();}
});

test('real ABC xrefs include class buffers and string sites without inventing log calls',async()=>{
 const root=await fs.mkdtemp(resolve(tmpdir(),'hap-xrefs-'));
 try{
  const loader=resolve(workspace,'node_modules/tsx/dist/loader.mjs');
  const input=resolve(workspace,'packages/xpanda-core/test/resources/class.abc');
  const run=spawnSync(process.execPath,[resolve(here,'../src/code-index.mjs'),'build',input,'--database',resolve(root,'fixture.db')],{encoding:'utf8',env:{...process.env,HAP_CODE_INDEX:'1'},maxBuffer:16*1024*1024});
  assert.equal(run.status,0,run.stderr);
  const db=openIndex(resolve(root,'fixture.db'));
  try{
   const to=(kind,offset)=>queryIndex(db,'xrefs',[kind,String(offset)],{entry:'class.abc'});
   const constructor=to('method',321).rows;
   assert.ok(constructor.some(row=>row.source_method_offset===375&&row.pc===3&&row.relation==='class_constructor'));
   assert.ok(to('method',348).rows.some(row=>row.opcode==='definemethod'&&row.pc===45));
   assert.ok(to('literal_array',425).rows.some(row=>row.pc===3&&row.operand_path==='param[2]'));
   const string=to('string',213).rows;
   assert.equal(string.length,1);assert.equal(string[0].pc,6);assert.equal(string[0].source_method_offset,348);
   const outgoing=queryIndex(db,'uses',[],{entry:'class.abc','class-offset':273,'method-offset':348});
   const calls=outgoing.rows.filter(row=>row.relation==='dynamic_call');
   assert.equal(calls.length,1);assert.equal(calls[0].pc,19);
   assert.equal(calls[0].target_offset,null);assert.equal(calls[0].resolution,'unresolved_dynamic');
   assert.ok(outgoing.rows.every(row=>row.relation!=='direct_call'));
   const stats=queryIndex(db,'stats');assert.ok(stats.counts.xrefs>0);assert.ok(stats.counts.unresolved_calls>0);
   assert.equal(stats.metadata.cross_references.version,1);
   assert.equal(stats.metadata.call_graph,'not_built');
   const read=queryIndex(db,'method',['L_GLOBAL;','test'],{entry:'class.abc'});
   assert.ok(read.instructions.some(row=>row.pc===19&&row.opcode==='callthis1'));
  }finally{db.close();}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('nested literal objects retain exact method/string identities and stop at cycles',()=>{
 const script=`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import {DatabaseSync} from 'node:sqlite';
  import {PandaFile} from 'xpanda-core';
  import {referenceWriter} from './packages/xpanda-index/src/code-index-xref-build.mjs';
  import {SCHEMA} from './packages/xpanda-index/src/code-index-db.mjs';
  const p=new PandaFile(fs.readFileSync('./packages/xpanda-core/test/resources/class.abc'));
  const clazz=p.getAllClasses().find(c=>c.getOffset()===273);
  const methods=[...clazz.pandaMethods.values()],main=methods.find(m=>m.getOffset()===375),callee=methods.find(m=>m.getOffset()===348);
  const cfg=main.disAssemble(),i=cfg.pandaIRBasicBlocks.flatMap(b=>b.pandaInstructions).find(i=>i.pc===3),array=i.params[2].obj;
  array.pandaLiterals.splice(0,array.pandaLiterals.length,callee,callee.name,array);
  const db=new DatabaseSync(':memory:');db.exec(SCHEMA);
  db.prepare('INSERT INTO entries VALUES (?,?)').run('app.abc','fixture');
  db.prepare('INSERT INTO classes(entry,record,offset) VALUES (?,?,?)').run('app.abc',clazz.name.content,273);
  db.prepare('INSERT INTO methods VALUES (?,?,?,?,?,?,?,?,?,?)').run('app.abc',273,clazz.name.content,main.name.content,375,0,0,0,null,'[]');
  referenceWriter(db)('app.abc',clazz,main,cfg);
  const rows=db.prepare("SELECT * FROM xrefs WHERE pc=3 ORDER BY id").all();
  assert.ok(rows.some(r=>r.target_offset===348&&r.relation==='literal_method'&&r.operand_path==='param[2].literal[0]'));
  assert.ok(rows.some(r=>r.target_offset===callee.name.getOffset()&&r.relation==='literal_string'));
  assert.equal(rows.filter(r=>r.target_kind==='literal_array').length,2);
  db.close();
 `;
 const run=spawnSync(process.execPath,['--import',resolve(workspace,'node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',script],{cwd:workspace,encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
});

test('old databases remain readable and explicitly require rebuilding for xrefs',async()=>{
 const root=await fs.mkdtemp(resolve(tmpdir(),'hap-xref-old-')),path=resolve(root,'old.db');
 try{
  const db=new DatabaseSync(path);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('schema_version','"1"');
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('artifact_sha256','"old"');
  db.exec('DROP TABLE xrefs; DROP TABLE xref_targets');db.close();
  const legacy=openIndex(path);
  try{
   assert.equal(queryIndex(legacy,'stats').counts.methods,0);
   assert.deepEqual(queryIndex(legacy,'methods').rows,[]);
   assert.throws(()=>queryIndex(legacy,'xrefs',['string','1'],{entry:'a.abc'}),/rebuild/i);
  }finally{legacy.close();}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as core from 'xpanda-core';

const sqlite=await import('node:sqlite').catch(error=>{if(error.code==='ERR_UNKNOWN_BUILTIN_MODULE')return null;throw error;});
const test=(name,fn)=>nodeTest(name,{skip:!sqlite},fn);

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const cli=resolve(root,'packages/xpanda-index/src/code-index.mjs');
const sample=resolve(root,'packages/xpanda-core/test/resources/class.abc');
const hash=value=>createHash('sha256').update(value).digest('hex');
const run=(args,cwd=tmpdir())=>spawnSync(process.execPath,[cli,...args],{cwd,encoding:'utf8',maxBuffer:4*1024*1024});

nodeTest('the public core entry exposes the entities required by a downstream index',()=>{
 for(const name of ['PandaFile','HapFile','PandaInstructionID','PandaMethod','PandaString','PandaField','PandaLiteralArray'])assert.equal(typeof core[name],'function',name);
});

test('standalone ABC indexing works outside the repository and navigates exact references',async()=>{
 const temp=await fs.mkdtemp(resolve(tmpdir(),'xpanda-index-')),database=resolve(temp,'standalone.sqlite');
 try{
  const build=run(['build',sample,'--database',database]);assert.equal(build.status,0,build.stderr);
  const stats=JSON.parse(build.stdout);assert.equal(stats.database,database);assert.equal(stats.counts.methods,4);
  assert.equal(stats.metadata.source_mode,'not_provided');assert.equal(stats.metadata.xpanda_version,JSON.parse(await fs.readFile(resolve(root,'packages/xpanda-core/package.json'),'utf8')).version);
  const refs=run(['xrefs',database,'method','321','--entry','class.abc']);assert.equal(refs.status,0,refs.stderr);
  assert.ok(JSON.parse(refs.stdout).rows.some(r=>r.pc===3&&r.relation==='class_constructor'));
  const uses=run(['uses',database,'--entry','class.abc','--class-offset','273','--method-offset','348']);assert.equal(uses.status,0,uses.stderr);
  assert.ok(JSON.parse(uses.stdout).rows.some(r=>r.pc===19&&r.resolution==='unresolved_dynamic'));
  const before=hash(await fs.readFile(database));
  const invalid=resolve(temp,'invalid.abc');await fs.writeFile(invalid,'not an ABC');
  assert.notEqual(run(['build',invalid,'--database',database]).status,0);
  assert.equal(hash(await fs.readFile(database)),before);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('session indexing preserves hashed sources and rejects stale inventories',async()=>{
 const temp=await fs.mkdtemp(resolve(tmpdir(),'xpanda-session-'));
 try{
  const data=await fs.readFile(sample),source='function test() { return "source needle"; }';
  await fs.mkdir(resolve(temp,'input'));await fs.mkdir(resolve(temp,'decompiled'));
  await fs.writeFile(resolve(temp,'input/app.abc'),data);await fs.writeFile(resolve(temp,'decompiled/fixture.js'),source);
  const inventory={input_mode:'raw_abc',sha256:hash(data),abcEntries:[{entry:'input/app.abc',sha256:hash(data)}],files:[{file:'decompiled/fixture.js',record:'L_GLOBAL;',sha256:hash(source),methods:[{name:'test',start:1,end:1}],diagnostics:[]}]};
  await fs.writeFile(resolve(temp,'inventory.json'),JSON.stringify(inventory));
  const built=run(['build',temp]);assert.equal(built.status,0,built.stderr);
  const read=run(['source',temp,'decompiled/fixture.js']);assert.equal(read.status,0,read.stderr);
  assert.equal(JSON.parse(read.stdout).lines[0].text,source);
  const search=run(['search',temp,'source needle']);assert.equal(search.status,0,search.stderr);
  assert.equal(JSON.parse(search.stdout).rows[0].file,'decompiled/fixture.js');
  const database=resolve(temp,'indexes/code-index.db'),before=hash(await fs.readFile(database));
  await fs.appendFile(resolve(temp,'decompiled/fixture.js'),'tampered');
  const failed=run(['build',temp]);assert.notEqual(failed.status,0);assert.match(failed.stderr,/Source integrity mismatch/);
  assert.equal(hash(await fs.readFile(database)),before);
  await fs.appendFile(resolve(temp,'inventory.json'),' ');
  const stale=run(['stats',temp]);assert.notEqual(stale.status,0);assert.match(stale.stderr,/stale/);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('standalone HAP indexing retains its ABC identities without running a decompiler',async()=>{
 const temp=await fs.mkdtemp(resolve(tmpdir(),'xpanda-hap-')),database=resolve(temp,'hap.db');
 try{
  const input=resolve(root,'packages/xpanda-core/test/resources/zhihupp0.59.hap');
  const result=run(['build',input,'--database',database]);assert.equal(result.status,0,result.stderr);
  const stats=JSON.parse(result.stdout);assert.ok(stats.counts.entries>0);assert.ok(stats.counts.methods>4);
  assert.equal(stats.counts.sources,0);assert.equal(stats.metadata.source_mode,'not_provided');
  const methods=run(['methods',database,'','--limit','1']);assert.equal(methods.status,0,methods.stderr);
  assert.match(JSON.parse(methods.stdout).rows[0].entry,/\.abc$/);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

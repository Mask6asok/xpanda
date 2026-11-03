import fs from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openIndex,queryIndex} from './code-index-db.mjs';

const here=dirname(fileURLToPath(import.meta.url));
export async function runCodeIndexCli(argv=process.argv.slice(2)){
try{
 const {positionals,values}=parseArgs({args:argv,allowPositionals:true,options:{database:{type:'string'},entry:{type:'string'},record:{type:'string'},limit:{type:'string'},offset:{type:'string'},'class-offset':{type:'string'},'method-offset':{type:'string'},'target-kind':{type:'string'},relation:{type:'string'}}});
 const [command,directory,...args]=positionals;
 if(!command||!directory)throw new Error('Usage: node code-index.mjs build|stats|classes|methods|strings|search|method|source|xrefs|uses SESSION_OR_DB_OR_INPUT [QUERY] [--database DB] [--entry ABC] [--class-offset N] [--method-offset N] [--limit 30] [--offset 0]');
 if(command==='build'){
  const run=spawnSync(process.execPath,['--import',fileURLToPath(import.meta.resolve('tsx')),resolve(here,'code-index-build.mjs'),resolve(directory),...(values.database?[resolve(values.database)]:[])],{stdio:'inherit'});
  if(run.error)throw run.error;
  process.exitCode=run.status??1;
 }else{
  const standalone=(await fs.stat(directory)).isFile();
  const path=standalone?resolve(directory):resolve(directory,'indexes/code-index.db');
  const db=openIndex(path);
  try{
   const result=queryIndex(db,command,args,values);
   if(!standalone){
    const text=await fs.readFile(resolve(directory,'inventory.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const metadata=result.metadata??Object.fromEntries(db.prepare("SELECT key,value FROM metadata WHERE key IN ('artifact_sha256','inventory_sha256')").all().map(row=>[row.key,JSON.parse(row.value)]));
    if(text&&(JSON.parse(text).sha256!==metadata.artifact_sha256||createHash('sha256').update(text).digest('hex')!==metadata.inventory_sha256))throw new Error('Index is stale or belongs to another input; rebuild it');
   }
   console.log(JSON.stringify(result,null,2));
  }finally{db.close();}
 }
}catch(error){console.error(error.message);process.exitCode=1;}

}
if(process.argv[1]===fileURLToPath(import.meta.url))await runCodeIndexCli();

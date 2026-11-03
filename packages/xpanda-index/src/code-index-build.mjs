import fs from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PandaFile} from 'xpanda-core';
import {loadIndexInput} from './code-index-input.mjs';
import {INDEX_VERSION,SCHEMA,indexStats,uniqueDefinitions} from './code-index-db.mjs';
import {referenceWriter} from './code-index-xref-build.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const require=createRequire(import.meta.url);

export async function buildCodeIndex(directory,options={}){
 const started=performance.now();
 const {root,inventoryText,inventory,entries,target,temporaryRoot:temp,standalone}=await loadIndexInput(directory,options);
 const temporary=resolve(temp,'index.db'),db=new DatabaseSync(temporary);
 let closed=false;
 try{
  db.exec(SCHEMA);db.exec('BEGIN');
  const putEntry=db.prepare('INSERT INTO entries VALUES (?,?)');
  const putClass=db.prepare('INSERT INTO classes(entry,record,offset,external,field_count) VALUES (?,?,?,?,?)');
  const putMethod=db.prepare('INSERT INTO methods VALUES (?,?,?,?,?,?,?,?,?,?)');
  const putString=db.prepare('INSERT INTO strings VALUES (?,?,?)');
  const putReferences=referenceWriter(db);
  const entryNames=entries.map(entry=>entry.name);
  let duplicateClasses=0,duplicateMethods=0;
  for(const entry of entries){
   const bytes=entry.read(),abcHash=hash(bytes),expected=inventory.abcEntries.find(row=>row.entry===entry.name);
   if(!expected||expected.sha256!==abcHash)throw new Error(`ABC identity mismatch: ${entry.name}`);
   putEntry.run(entry.name,abcHash);
   const panda=new PandaFile(bytes);
   const classes=uniqueDefinitions(panda.getAllClasses());duplicateClasses+=classes.duplicates;
   for(const clazz of classes.definitions){
    const record=clazz.name.content;
    putClass.run(entry.name,record,clazz.getOffset(),Number(clazz.classExternal),clazz.numFields);
    const methods=uniqueDefinitions(clazz.pandaMethods.values());duplicateMethods+=methods.duplicates;
    for(const method of methods.definitions){
     const name=method.name.content;
     let instructions=[],diagnostic=null,cfg=null;
     try{
      cfg=method.disAssemble();
      instructions=(cfg?.pandaIRBasicBlocks??[]).flatMap(block=>block.pandaInstructions.map(i=>({block:block.name,pc:i.pc,opcode:i.opcode.name,text:i.toString(),catch_by:block.catchBlockList?.map(b=>b.name)??[]})));
     }catch(error){diagnostic=String(error);}
     putMethod.run(entry.name,clazz.getOffset(),record,name,method.getOffset(),method.methodCode?.getOffset()??null,method.methodCode?.codeSize??0,instructions.length,diagnostic,JSON.stringify(instructions));
     if(!diagnostic)putReferences(entry.name,clazz,method,cfg);
    }
   }
   for(const value of panda.getAllStrings()){
    putString.run(entry.name,value.getOffset(),value.content);
   }
  }
  const putSource=db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?)');
  const putSourceFts=db.prepare('INSERT INTO sources_fts(rowid,content) VALUES (?,?)');
  const putSourceMethod=db.prepare('INSERT OR IGNORE INTO source_methods VALUES (?,?,?,?)');
  for(const source of inventory.files){
   const path=resolve(root,source.file),real=await fs.realpath(path);
   if(!real.startsWith(root+sep))throw new Error('Source path escapes session');
   const content=await fs.readFile(real,'utf8');
   if(hash(content)!==source.sha256)throw new Error(`Source integrity mismatch: ${source.file}`);
   const candidates=entryNames.filter(entry=>inventory.input_mode==='raw_abc'||source.file.startsWith(`decompiled/${entry.replace(/\.abc$/i,'')}/`)).sort((a,b)=>b.length-a.length);
   const entry=candidates[0]??null;
   const row=putSource.run(source.file,entry,source.record,source.sha256,content,JSON.stringify(source.diagnostics??[]));
   putSourceFts.run(row.lastInsertRowid,content);
   for(const method of source.methods??[])putSourceMethod.run(source.file,method.name,method.start,method.end);
  }
  db.exec(`UPDATE classes SET source_count=(SELECT count(*) FROM sources s WHERE s.entry=classes.entry AND s.record=classes.record);
    UPDATE classes SET source_file=(SELECT file FROM sources s WHERE s.entry=classes.entry AND s.record=classes.record) WHERE source_count=1 AND (SELECT count(*) FROM classes c WHERE c.entry=classes.entry AND c.record=classes.record)=1;`);
  const version=JSON.parse(await fs.readFile(require.resolve('xpanda-core/package.json'),'utf8')).version;
  const quality=inventory.decompilation;
  const decompilation=quality?{status:quality.status,records_total:quality.records_total,records_decompiled:quality.records_decompiled,methods_total:quality.methods_total,semantic_completeness:'unknown'}:null;
  const crossReferences={version:1,identity:'ABC entry + target kind + byte offset',scope:'successfully_disassembled_instruction_operands_and_reachable_literal_objects',dynamic_calls:'unresolved',dispatch_analysis:'not_built',literal_expansion:'each_array_once_per_operand'};
  const metadata={schema_version:INDEX_VERSION,artifact_sha256:inventory.sha256,input_mode:inventory.input_mode??'compiled_hap',inventory_sha256:inventoryText===null?null:hash(inventoryText),xpanda_version:version,indexer_version:JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version,source_mode:standalone?'not_provided':'inventory_verified',call_graph:'not_built',cross_references:crossReferences,string_scope:'xpanda_parsed_strings',semantic_completeness:'unknown',duplicate_class_records:duplicateClasses,duplicate_method_records:duplicateMethods,decompilation,build_ms:Math.round(performance.now()-started)};
  const putMeta=db.prepare('INSERT INTO metadata VALUES (?,?)');
  for(const [key,value] of Object.entries(metadata))putMeta.run(key,JSON.stringify(value));
  if(root&&hash(await fs.readFile(resolve(root,'inventory.json')))!==metadata.inventory_sha256)throw new Error('Inventory changed during indexing');
  db.exec('COMMIT');
  const result=indexStats(db);
  db.close();closed=true;
  await fs.rename(temporary,target);
  return {database:target,bytes:(await fs.stat(target)).size,elapsed_ms:Math.round(performance.now()-started),...result};
 }finally{
  if(!closed)db.close();
  await fs.rm(temp,{recursive:true,force:true});
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await buildCodeIndex(process.argv[2],{database:process.argv[3]}),null,2));}
 catch(error){console.error(error.message);process.exitCode=1;}
}

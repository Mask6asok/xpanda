import fs from 'node:fs/promises';
import {resolve,basename,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {HapFile} from 'xpanda-core';

const hash=value=>createHash('sha256').update(value).digest('hex');

export async function loadIndexInput(directory,{database}={}){
 const path=await fs.realpath(resolve(directory)),standalone=(await fs.stat(path)).isFile();
 const root=standalone?null:path;
 let inventoryText=null,inventory,data,input;
 if(standalone){
  if(!/\.(abc|hap|hsp)$/i.test(path))throw new Error('Input must be an ABC/HAP/HSP file or an indexed session directory');
  input=basename(path);data=await fs.readFile(path);
  inventory={sha256:hash(data),input_mode:/\.abc$/i.test(path)?'raw_abc':'compiled_hap',files:[]};
 }else{
  inventoryText=await fs.readFile(resolve(root,'inventory.json'),'utf8');inventory=JSON.parse(inventoryText);
  input=inventory.input_mode==='package_abc_overlay'?'input/app.json':inventory.input_mode==='raw_abc'?'input/app.abc':'input/app.hap';
  data=await fs.readFile(resolve(root,input));
  if(hash(data)!==inventory.sha256)throw new Error('Input differs from frozen inventory');
 }
 let entries;
 if(inventory.input_mode==='package_abc_overlay'){
  entries=[];
  for(const row of inventory.abcEntries){
   if(typeof row.input_ref!=='string'||row.input_ref.split(/[\\/]/).includes('..'))throw new Error('Unsafe frozen ABC reference');
   const path=await fs.realpath(resolve(root,row.input_ref));
   if(!path.startsWith(root+sep))throw new Error('Frozen ABC escapes session');
   const bytes=await fs.readFile(path);if(hash(bytes)!==row.sha256)throw new Error('ABC identity mismatch');
   entries.push({name:row.entry,read:()=>bytes});
  }
 }else entries=inventory.input_mode==='raw_abc'?[{name:input,read:()=>data}]:new HapFile(data).getAbcEntries();
 if(standalone)inventory.abcEntries=entries.map(entry=>({entry:entry.name,sha256:hash(entry.read())}));
 const target=database?resolve(database):standalone?resolve(path+'.index.db'):resolve(root,'indexes/code-index.db');
 await fs.mkdir(dirname(target),{recursive:true});
 // Session staging stays outside the snapshot inputs; standalone staging stays beside the target.
 const staging=root&&target===resolve(root,'indexes/code-index.db')?resolve(root,'runtime'):dirname(target);
 await fs.mkdir(staging,{recursive:true});
 if((await fs.stat(staging)).dev!==(await fs.stat(dirname(target))).dev)throw new Error('Database staging and destination must share a filesystem');
 const temporaryRoot=await fs.mkdtemp(resolve(staging,'.xpanda-index-'));
 return {root,inventoryText,inventory,entries,target,temporaryRoot,standalone};
}

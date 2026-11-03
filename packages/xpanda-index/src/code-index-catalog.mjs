import fs from 'node:fs/promises';
import {resolve,dirname,basename,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {openIndex} from './code-index-db.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const stamp=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
async function optionalStat(path){
 try{return await fs.stat(path,{bigint:true});}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export class CodeIndexCatalog {
 constructor({root=null,databases=[],maxOpen=4}={}){
  this.root=root;this.databases=databases;this.maxOpen=maxOpen;
  this.indexes=new Map();this.connections=new Map();
 }

 async refresh(){
  const indexes=new Map();
  const add=async(path,allowedRoot=null)=>{
   let database;
   try{database=await fs.realpath(path);}catch(error){if(error.code==='ENOENT')return;throw error;}
   if(allowedRoot&&!database.startsWith(allowedRoot.endsWith(sep)?allowedRoot:allowedRoot+sep))return;
   const index_id='idx-'+hash(database).slice(0,16);
   const session=dirname(dirname(database)),inSession=basename(dirname(database))==='indexes';
   indexes.set(index_id,{index_id,database,name:inSession?basename(session):basename(database),inventory:inSession?resolve(session,'inventory.json'):null});
  };
  for(const path of this.databases)await add(resolve(path));
  if(this.root){
   let root;
   try{root=await fs.realpath(this.root);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(root)for(const entry of await fs.readdir(root,{withFileTypes:true})){
    if(entry.isDirectory())await add(resolve(root,entry.name,'indexes/code-index.db'),root);
   }
  }
  for(const [id,connection] of this.connections)if(!indexes.has(id)){
   connection.db.close();this.connections.delete(id);
  }
  this.indexes=indexes;
 }

 async get(index_id){
  if(!this.indexes.has(index_id))await this.refresh();
  const descriptor=this.indexes.get(index_id);
  if(!descriptor)throw new Error('Unknown index_id; use code_index_list to choose an allowed index');
  if(await fs.realpath(descriptor.database)!==descriptor.database)throw new Error('Index path changed; list indexes again');
  const current=stamp(await fs.stat(descriptor.database,{bigint:true}));
  let connection=this.connections.get(index_id);
  if(connection?.stamp!==current){
   connection?.db.close();this.connections.delete(index_id);
   const db=openIndex(descriptor.database);
   connection={db,stamp:current,inventoryStamp:null};
  }
  this.connections.delete(index_id);this.connections.set(index_id,connection);
  while(this.connections.size>this.maxOpen){
   const oldest=this.connections.keys().next().value;
   this.connections.get(oldest).db.close();this.connections.delete(oldest);
  }
  const stat=descriptor.inventory?await optionalStat(descriptor.inventory):null;
  let freshness='offline';
  if(stat){
   const currentInventory=stamp(stat);
   if(connection.inventoryStamp!==currentInventory){
    const text=await fs.readFile(descriptor.inventory,'utf8');
    if(stamp(await fs.stat(descriptor.inventory,{bigint:true}))!==currentInventory)throw new Error('Inventory changed during verification; retry');
    connection.inventoryHash=hash(text);connection.artifactHash=JSON.parse(text).sha256;connection.inventoryStamp=currentInventory;
   }
   const metadata=Object.fromEntries(connection.db.prepare("SELECT key,value FROM metadata WHERE key IN ('artifact_sha256','inventory_sha256')").all().map(row=>[row.key,JSON.parse(row.value)]));
   if(connection.inventoryHash!==metadata.inventory_sha256||connection.artifactHash!==metadata.artifact_sha256)throw new Error('Index is stale or belongs to another input; rebuild it outside MCP');
   freshness='current';
  }
  return {...descriptor,db:connection.db,freshness};
 }

 async list({limit=30,offset=0}={}){
  await this.refresh();
  const descriptors=[...this.indexes.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.index_id.localeCompare(b.index_id));
  const indexes=[];
  for(const descriptor of descriptors.slice(offset,offset+limit)){
   const {inventory,...item}=descriptor;
   try{
    const selected=await this.get(item.index_id);
    const row=selected.db.prepare('SELECT value FROM metadata WHERE key=?').get('artifact_sha256');
    indexes.push({...item,status:selected.freshness,artifact_sha256:JSON.parse(row.value)});
   }catch(error){indexes.push({...item,status:'error',error:error.message});}
  }
  return {indexes,limit,offset,total_indexes:descriptors.length};
 }

 close(){
  for(const connection of this.connections.values())connection.db.close();
  this.connections.clear();
 }
}

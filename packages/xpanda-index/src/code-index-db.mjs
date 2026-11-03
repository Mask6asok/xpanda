import {DatabaseSync} from 'node:sqlite';
import {XREF_SCHEMA,queryReferences} from './code-index-xrefs.mjs';

export const INDEX_VERSION='2';
export function uniqueDefinitions(items){
 const offsets=new Map();
 let duplicates=0;
 for(const item of items){
  const offset=item.getOffset();
  if(offsets.has(offset))duplicates++;
  else offsets.set(offset,item);
 }
 return {definitions:[...offsets.values()],duplicates};
}

export const SCHEMA=`
 PRAGMA journal_mode=DELETE;
 PRAGMA cache_size=-8192;
 CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE entries(entry TEXT PRIMARY KEY,sha256 TEXT NOT NULL);
 CREATE TABLE classes(entry TEXT,record TEXT,offset INTEGER,external INTEGER,field_count INTEGER,
   source_file TEXT,source_count INTEGER DEFAULT 0,PRIMARY KEY(entry,offset),FOREIGN KEY(entry) REFERENCES entries(entry));
 CREATE TABLE methods(entry TEXT,class_offset INTEGER,record TEXT,name TEXT,offset INTEGER,code_offset INTEGER,code_size INTEGER,
   instruction_count INTEGER,diagnostic TEXT,instructions TEXT NOT NULL,PRIMARY KEY(entry,class_offset,offset),
   FOREIGN KEY(entry,class_offset) REFERENCES classes(entry,offset));
 CREATE INDEX methods_name ON methods(name);
 CREATE TABLE strings(entry TEXT,offset INTEGER,value TEXT NOT NULL,PRIMARY KEY(entry,offset),
   FOREIGN KEY(entry) REFERENCES entries(entry));
 CREATE TABLE sources(file TEXT PRIMARY KEY,entry TEXT,record TEXT,sha256 TEXT NOT NULL,content TEXT NOT NULL,
   diagnostics TEXT NOT NULL);
 CREATE VIRTUAL TABLE sources_fts USING fts5(content,content='sources',content_rowid='rowid');
 CREATE INDEX sources_record ON sources(entry,record);
 CREATE TABLE source_methods(file TEXT,name TEXT,start INTEGER,end INTEGER,PRIMARY KEY(file,name,start,end),
   FOREIGN KEY(file) REFERENCES sources(file));
 ${XREF_SCHEMA}
`;

export function openIndex(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const version=db.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version')?.value;
  if(![JSON.stringify('1'),JSON.stringify(INDEX_VERSION)].includes(version))throw new Error('Unsupported or unfinished code index; rebuild it');
  db.exec('PRAGMA query_only=ON');
  return db;
 }catch(error){db.close();throw error;}
}

export function indexStats(db){
 const metadata=Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row=>[row.key,JSON.parse(row.value)]));
 const counts={};
 for(const table of ['entries','classes','methods','strings','sources','source_methods'])counts[table]=db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
 counts.instructions=db.prepare('SELECT coalesce(sum(instruction_count),0) n FROM methods').get().n;
 counts.failed_disassembly=db.prepare('SELECT count(*) n FROM methods WHERE diagnostic IS NOT NULL').get().n;
 if(metadata.schema_version!=='1'){
  for(const table of ['xrefs','xref_targets'])counts[table]=db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  counts.unresolved_calls=db.prepare("SELECT count(*) n FROM xrefs WHERE resolution='unresolved_dynamic'").get().n;
  counts.unresolved_operands=db.prepare("SELECT count(*) n FROM xrefs WHERE resolution='unresolved_operand'").get().n;
 }
 return {metadata,counts};
}

function windowOptions(options){
 const limit=Number(options.limit??30),offset=Number(options.offset??0);
 if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)throw new Error('limit must be 1..200 and offset must be nonnegative');
 const classOffset=options['class-offset']==null?null:Number(options['class-offset']);
 if(classOffset!==null&&(!Number.isSafeInteger(classOffset)||classOffset<0))throw new Error('class-offset must be a nonnegative integer');
 const methodOffset=options['method-offset']==null?null:Number(options['method-offset']);
 if(methodOffset!==null&&(!Number.isSafeInteger(methodOffset)||methodOffset<0))throw new Error('method-offset must be a nonnegative integer');
 return {limit,offset,entry:options.entry??null,record:options.record??null,class_offset:classOffset,method_offset:methodOffset};
}

export function queryIndex(db,command,args=[],options={}){
 const page=windowOptions(options),[query='',name]=args;
 const filters=[page.entry,page.entry,page.record,page.record];
 const where='(? IS NULL OR m.entry=?) AND (? IS NULL OR m.record=?)';
 const provenance={artifact_sha256:JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get('artifact_sha256').value),representation:'derived-code-index',call_graph:'not_built'};
 switch(command){
  case 'stats':return indexStats(db);
  case 'xrefs':case 'uses':return queryReferences(db,command,args,options,page,provenance);
  case 'classes':{
   const rows=db.prepare('SELECT * FROM classes m WHERE instr(lower(record),lower(?))>0 AND '+where+' ORDER BY entry,record LIMIT ? OFFSET ?').all(query,...filters,page.limit,page.offset);
   return {rows,...page,provenance};
  }
  case 'methods':{
   const rows=db.prepare('SELECT m.entry,m.class_offset,m.record,m.name,m.offset,m.code_offset,m.code_size,m.instruction_count,m.diagnostic,c.source_file,c.source_count FROM methods m JOIN classes c ON c.entry=m.entry AND c.offset=m.class_offset WHERE instr(lower(m.name),lower(?))>0 AND '+where+' ORDER BY m.entry,m.record,m.name,m.offset LIMIT ? OFFSET ?').all(query,...filters,page.limit,page.offset);
   return {rows,...page,provenance};
  }
  case 'strings':{
   const rows=db.prepare('SELECT entry,offset,substr(value,1,2000) value,length(value) characters FROM strings WHERE instr(lower(value),lower(?))>0 AND (? IS NULL OR entry=?) ORDER BY entry,offset LIMIT ? OFFSET ?').all(query,page.entry,page.entry,page.limit,page.offset);
   return {rows,...page,scope:'xpanda_parsed_strings',provenance};
  }
  case 'search':{
   if(!query.trim())throw new Error('search needs a nonempty literal phrase');
   const phrase='"'+query.replaceAll('"','""')+'"';
   const rows=db.prepare("SELECT s.file,s.entry,s.record,s.sha256,substr(snippet(sources_fts,0,'[',']',' … ',32),1,2000) snippet FROM sources_fts JOIN sources s ON s.rowid=sources_fts.rowid WHERE sources_fts MATCH ? AND (? IS NULL OR s.entry=?) ORDER BY sources_fts.rank,s.file LIMIT ? OFFSET ?").all(phrase,page.entry,page.entry,page.limit,page.offset);
   return {rows,...page,mode:'fts_literal_phrase',provenance};
  }
  case 'method':{
   if(!query||!name)throw new Error('method needs exact RECORD and METHOD names');
   const matches=db.prepare('SELECT m.*,e.sha256 abc_sha256,c.source_file,c.source_count FROM methods m JOIN entries e USING(entry) JOIN classes c ON c.entry=m.entry AND c.offset=m.class_offset WHERE m.record=? AND m.name=? AND (? IS NULL OR m.entry=?) AND (? IS NULL OR m.class_offset=?) AND (? IS NULL OR m.offset=?) LIMIT 2').all(query,name,page.entry,page.entry,page.class_offset,page.class_offset,page.method_offset,page.method_offset);
   if(matches.length!==1)throw new Error(matches.length?'Ambiguous method; select --entry, --class-offset and --method-offset':'Method not found');
   const method=matches[0],instructions=JSON.parse(method.instructions);delete method.instructions;
   const sources=method.source_file?db.prepare('SELECT name,start,end FROM source_methods WHERE file=? AND name=? ORDER BY start LIMIT 20').all(method.source_file,name):[];
   const selected=instructions.slice(page.offset,page.offset+page.limit).map(instruction=>({...instruction,text:instruction.text.slice(0,2000),truncated:instruction.text.length>2000}));
   return {method,instructions:selected,total_instructions:instructions.length,source_method_candidates:sources,...page,provenance};
  }
  case 'source':{
   const source=db.prepare('SELECT * FROM sources WHERE file=?').get(query);
   if(!source)throw new Error('Source file not found');
   const lines=source.content.split('\n'),selected=lines.slice(page.offset,page.offset+page.limit).map((text,i)=>({line:page.offset+i+1,text:text.slice(0,2000),truncated:text.length>2000}));
   delete source.content;source.diagnostics=JSON.parse(source.diagnostics);
   return {source,lines:selected,total_lines:lines.length,...page,provenance};
  }
  default:throw new Error('Commands: build, stats, classes, methods, strings, search, method, source, xrefs, uses');
 }
}

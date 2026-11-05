import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {CodeIndexCatalog} from './code-index-catalog.mjs';
import {queryIndex} from './code-index-db.mjs';
import {TARGET_KINDS,XREF_RELATIONS} from './code-index-xrefs.mjs';

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

function boundedResult(result,maxChars){
 const collection=['indexes','rows','instructions','lines'].find(key=>Array.isArray(result[key]));
 if(collection){
  const rows=result[collection],original=rows.length;
  const update=()=>{
   const next=(result.offset??0)+rows.length;
   const total=result.total_indexes??result.total_instructions??result.total_lines;
   const more=total==null?(rows.length<original||original===result.limit):next<total;
   result.returned=rows.length;result.next_offset=more?next:null;
   result.response_truncated=rows.length<original;
  };
  update();
  while(JSON.stringify(result).length>maxChars&&rows.length>1){rows.pop();update();}
 }
 const text=JSON.stringify(result);
 if(text.length>maxChars)throw new Error('Result exceeds response budget; request a smaller page or a narrower query');
 return {content:[{type:'text',text}],structuredContent:result};
}

export function createCodeIndexMcp(args=process.argv.slice(2),identity={name:'hap-code-index',version:'1.1.0'}){
 const {values}=parseArgs({args,options:{root:{type:'string'},database:{type:'string',multiple:true},'max-output-chars':{type:'string'}}});
 const maxChars=Number(values['max-output-chars']??65536);
 if(!Number.isInteger(maxChars)||maxChars<1024||maxChars>262144)throw new Error('max-output-chars must be 1024..262144');
 const root=values.root??(values.database?.length?null:resolve('.hap-sec-analysis'));
 const catalog=new CodeIndexCatalog({root,databases:values.database??[]});
 const server=new McpServer(identity,{instructions:'Start with code_index_list for persisted indexes. Live abc_* tools, when available, use fileId from abc_load; HAP entries require hap_read_abc. Index IDs and live file IDs are separate. Use xrefs/uses for exact operand references; definitions and property-name strings are not proven call edges. Dynamic call targets remain unresolved. Cite original evidence for security claims. Source offsets are zero-based; returned source line numbers are one-based. Use next_offset to continue paginated reads.'});
 const index_id=z.string().min(1).max(128),text=z.string().max(8192),entry=text.optional();
 const page={limit:z.number().int().min(1).max(200).default(30),offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)};
 const common={index_id,query:text.default(''),entry,...page};
 const address=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),relation=z.enum(XREF_RELATIONS).optional();
 const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
 let queue=Promise.resolve();
 const register=(name,description,shape,action)=>{
  server.registerTool(name,{description,inputSchema:z.object(shape).strict(),annotations},async args=>{
   // A synchronous SQLite connection must not be evicted while another call awaits inventory I/O.
   const execution=queue.then(()=>action(args));
   queue=execution.then(()=>undefined,()=>undefined);
   try{return boundedResult(await execution,maxChars);}
   catch(error){const result={error:error.message};return {isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
  });
 };
 const query=async(command,args,selectors=[])=>{
  const selected=await catalog.get(args.index_id);
  const options={...args,'class-offset':args.class_offset,'method-offset':args.method_offset,'target-kind':args.target_kind};
  return {index_id:args.index_id,freshness:selected.freshness,...queryIndex(selected.db,command,selectors,options)};
 };
 register('code_index_list','List allowed SQLite indexes and their freshness; use returned index_id values.',page,args=>catalog.list(args));
 register('code_index_stats','Read index counts, input identity, producer version and analysis limitations.',{index_id},args=>query('stats',args));
 register('code_index_classes','Find classes by record-name substring. Distinct offsets are distinct definitions.',{...common,record:entry},args=>query('classes',args,[args.query]));
 register('code_index_methods','Find methods by name substring, optionally limited to an ABC entry and exact record.',{...common,record:entry},args=>query('methods',args,[args.query]));
 register('code_index_strings','Search xpanda-parsed strings by substring; pass entry and returned offset to xrefs with target_kind=string.',common,args=>query('strings',args,[args.query]));
 register('code_index_search','Search decompiled source using an FTS5 literal phrase; returns candidate snippets and source hashes.',{...common,query:text.min(1)},args=>query('search',args,[args.query]));
 register('code_index_method','Read paginated disassembly for an exact record and method. Disambiguate with entry/class_offset/method_offset.',{index_id,record:text.min(1),name:text.min(1),entry,class_offset:address.optional(),method_offset:address.optional(),...page},args=>query('method',args,[args.record,args.name]));
 register('code_index_source','Read paginated lines stored in the index for an exact file key; does not read arbitrary filesystem paths.',{index_id,file:text.min(1),...page},args=>query('source',args,[args.file]));
 register('code_index_xrefs','Find incoming references to an exact ABC entity. target_offset is its entity byte offset, not a pagination offset. Returns referencing methods, instruction PC and relation; method definitions are not calls. V1 indexes require a rebuild.',{index_id,entry:text.min(1),target_kind:z.enum(TARGET_KINDS),target_offset:address,relation,...page},args=>query('xrefs',args,[args.target_kind,args.target_offset]));
 register('code_index_uses','List outgoing operand references and unresolved dynamic call sites for an exact method identity returned by methods. instruction_index locates a site in code_index_method pagination. target_kind/relation optionally filter results.',{index_id,entry:text.min(1),class_offset:address,method_offset:address,target_kind:z.enum(TARGET_KINDS).optional(),relation,...page},args=>query('uses',args));
 server.server.onclose=()=>catalog.close();
 return {server,close:()=>catalog.close()};
}

export async function startCodeIndexMcp(args=process.argv.slice(2)){
 const {server,close}=createCodeIndexMcp(args);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{close();process.exit(0);});
 await server.connect(new StdioServerTransport());
}

if(process.argv[1]===fileURLToPath(import.meta.url))startCodeIndexMcp().catch(error=>{console.error(`hap-code-index MCP: ${error.message}`);process.exitCode=1;});

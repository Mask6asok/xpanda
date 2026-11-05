import {fileURLToPath} from 'node:url';
import {parseArgs,format} from 'node:util';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createCodeIndexMcp} from './code-index-mcp.mjs';

export async function createUnifiedMcp(args=process.argv.slice(2)){
 const {values}=parseArgs({args,options:{root:{type:'string'},database:{type:'string',multiple:true},'max-output-chars':{type:'string'},'read-only':{type:'boolean',default:false}}});
 // Live decompiler diagnostics must never enter the JSON-RPC stdout stream.
 const diagnostic=(...items)=>process.stderr.write(format(...items)+'\n');
 console.log=diagnostic;console.warn=diagnostic;console.error=diagnostic;
 const result=createCodeIndexMcp(args.filter(arg=>arg!=='--read-only'),{name:'hap-analysis',version:'1.0.0'});
 if(!values['read-only']){
  const {require:loadTypeScript}=await import('tsx/cjs/api');
  const {registerXpandaTools}=loadTypeScript('xpanda-mcp/tools',import.meta.url);
  registerXpandaTools(result.server);
 }
 return {...result,readOnly:values['read-only']};
}

export async function startUnifiedMcp(args=process.argv.slice(2),configure=()=>{}){
 const result=await createUnifiedMcp(args);
 await configure(result);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await result.server.close();process.exit(0);});
 await result.server.connect(new StdioServerTransport());
 return result;
}

if(process.argv[1]===fileURLToPath(import.meta.url))startUnifiedMcp().catch(error=>{console.error(error);process.exitCode=1;});

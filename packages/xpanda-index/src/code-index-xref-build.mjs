import {PandaInstructionID,PandaMethod,PandaString,PandaField,PandaLiteralArray} from "xpanda-core";

const kinds={METHOD:'method',STRING:'string',FIELD:'field',LITERALARRAY:'literal_array',TYPE:'type'};
const dynamicKinds=new Set(['call','superCall','superCallSpread','superCallForwardAllArgs','newObjRange','newObjSpread']);
function kindOf(object){
 if(object instanceof PandaMethod)return 'method';
 if(object instanceof PandaString)return 'string';
 if(object instanceof PandaField)return 'field';
 if(object instanceof PandaLiteralArray)return 'literal_array';
 return null;
}

function relationFor(kind,instruction,nested){
 if(nested)return kind==='literal_array'?'nested_literal_array':`literal_${kind}`;
 if(kind==='method')return instruction.kind==='defineFunc'?'function_definition':instruction.kind==='defineClassWithBuffer'?'class_constructor':'method_reference';
 return `${kind}_operand`;
}

export function referenceWriter(db){
 const symbol=db.prepare('INSERT OR IGNORE INTO xref_targets VALUES (?,?,?,?,?,?)');
 const reference=db.prepare(`INSERT INTO xrefs(entry,source_class_offset,source_method_offset,instruction_index,pc,block,opcode,operand_path,relation,resolution,target_kind,target_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
 return (entry,clazz,method,cfg)=>{
  const seen=new Set();let index=0;
  for(const block of cfg?.pandaIRBasicBlocks??[])for(const instruction of block.pandaInstructions){
   const at=index++;
   const put=(path,relation,resolution,kind=null,offset=null)=>{
    const key=`${instruction.pc}:${path}`;
    if(seen.has(key))return;
    seen.add(key);
    reference.run(entry,clazz.getOffset(),method.getOffset(),at,instruction.pc,block.name,instruction.opcode.name,path,relation,resolution,kind,offset);
   };
   instruction.params.forEach((param,paramIndex)=>{
    if(!(param instanceof PandaInstructionID))return;
    const visited=new Set(),stack=[{object:param.obj,kind:kinds[param.type],path:`param[${paramIndex}]`,nested:false}];
    while(stack.length){
     const {object,kind,path,nested}=stack.pop();
     if(!object){put(path,relationFor(kind,instruction,nested),'unresolved_operand',kind);continue;}
     // Identity comes from the resolved operand object, never from its printed name.
     if(kindOf(object)!==kind)throw new Error(`Operand type mismatch at ${entry}:${method.getOffset()}:${instruction.pc}:${path}`);
     const offset=object.getOffset(),parent=object.getParent?.();
     symbol.run(entry,kind,offset,object.name?.content??object.content??null,parent?.name?.content??null,parent?.getOffset()??null);
     put(path,relationFor(kind,instruction,nested),'exact_operand',kind,offset);
     if(kind==='literal_array'&&!visited.has(offset)){
      visited.add(offset);
      const literals=object.getLiterals();
      for(let i=literals.length-1;i>=0;i--){
       const child=literals[i],childKind=kindOf(child);
       if(childKind)stack.push({object:child,kind:childKind,path:`${path}.literal[${i}]`,nested:true});
      }
     }
    }
   });
   if(dynamicKinds.has(instruction.kind))put('$call','dynamic_call','unresolved_dynamic');
   else if(instruction.kind==='callRuntime')put('$runtime','runtime_intrinsic','runtime_intrinsic');
  }
 };
}

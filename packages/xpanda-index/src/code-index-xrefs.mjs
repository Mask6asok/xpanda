export const TARGET_KINDS=['method','string','field','literal_array','type'];
export const XREF_RELATIONS=['function_definition','class_constructor','method_reference','string_operand','field_operand','type_operand','literal_array_operand','literal_method','literal_string','literal_field','nested_literal_array','dynamic_call','runtime_intrinsic'];

export const XREF_SCHEMA=`
 CREATE TABLE xref_targets(entry TEXT NOT NULL,kind TEXT NOT NULL,offset INTEGER NOT NULL,
   name TEXT,record TEXT,class_offset INTEGER,PRIMARY KEY(entry,kind,offset)) WITHOUT ROWID;
 CREATE TABLE xrefs(id INTEGER PRIMARY KEY,entry TEXT NOT NULL,source_class_offset INTEGER NOT NULL,
   source_method_offset INTEGER NOT NULL,instruction_index INTEGER NOT NULL,pc INTEGER NOT NULL,
   block TEXT NOT NULL,opcode TEXT NOT NULL,operand_path TEXT NOT NULL,relation TEXT NOT NULL,
   resolution TEXT NOT NULL,target_kind TEXT,target_offset INTEGER,
   UNIQUE(entry,source_class_offset,source_method_offset,pc,operand_path),
   FOREIGN KEY(entry,source_class_offset,source_method_offset) REFERENCES methods(entry,class_offset,offset));
 CREATE INDEX xrefs_to ON xrefs(entry,target_kind,target_offset,id) WHERE target_offset IS NOT NULL;
`;

function natural(value,label){
 if(value==null||value==='')throw new Error(`${label} is required`);
 const number=Number(value);
 if(!Number.isSafeInteger(number)||number<0)throw new Error(`${label} must be a nonnegative integer`);
 return number;
}

export function queryReferences(db,command,args,options,page,provenance){
 const version=JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value);
 if(version==='1')throw new Error('Cross references are unavailable in this index; rebuild it');
 if(!page.entry)throw new Error('entry is required for exact ABC identity');
 const relation=options.relation??null,kind=command==='xrefs'?args[0]:options['target-kind']??null;
 if(relation!==null&&!XREF_RELATIONS.includes(relation))throw new Error('Unknown xref relation');
 if(kind!==null&&!TARGET_KINDS.includes(kind))throw new Error('Unknown target kind');
 let target=null,method=null,where,parameters;
 if(command==='xrefs'){
  if(!kind)throw new Error('target kind is required');
  const offset=natural(args[1],'target_offset');
  if(!db.prepare('SELECT 1 FROM entries WHERE entry=?').get(page.entry))throw new Error('ABC entry not found');
  target=db.prepare('SELECT entry,kind,offset,substr(name,1,2000) name,record,class_offset FROM xref_targets WHERE entry=? AND kind=? AND offset=?').get(page.entry,kind,offset)??{entry:page.entry,kind,offset};
  where='x.entry=? AND x.target_kind=? AND x.target_offset=?';parameters=[page.entry,kind,offset];
 }else{
  const classOffset=natural(options['class-offset'],'class-offset'),methodOffset=natural(options['method-offset'],'method-offset');
  method=db.prepare('SELECT entry,class_offset,record,name,offset,code_offset,code_size,instruction_count,diagnostic FROM methods WHERE entry=? AND class_offset=? AND offset=?').get(page.entry,classOffset,methodOffset);
  if(!method)throw new Error('Method not found');
  where='x.entry=? AND x.source_class_offset=? AND x.source_method_offset=?';parameters=[page.entry,classOffset,methodOffset];
  if(kind!==null){where+=' AND x.target_kind=?';parameters.push(kind);}
 }
 if(relation!==null){where+=' AND x.relation=?';parameters.push(relation);}
 const rows=db.prepare(`SELECT x.*,m.record source_record,m.name source_name,e.sha256 abc_sha256,
   substr(t.name,1,2000) target_name,length(t.name) target_name_characters,t.record target_record,t.class_offset target_class_offset
   FROM xrefs x JOIN methods m ON m.entry=x.entry AND m.class_offset=x.source_class_offset AND m.offset=x.source_method_offset
   JOIN entries e ON e.entry=x.entry LEFT JOIN xref_targets t ON t.entry=x.entry AND t.kind=x.target_kind AND t.offset=x.target_offset
   WHERE ${where} ORDER BY ${command==='uses'?'x.pc,x.operand_path':'x.id'} LIMIT ? OFFSET ?`).all(...parameters,page.limit,page.offset);
 return {direction:command==='xrefs'?'incoming':'outgoing',...(target?{target}:{method}),rows,...page,relation,target_kind:kind,
  scope:'instruction_operands_and_reachable_literal_objects',provenance};
}

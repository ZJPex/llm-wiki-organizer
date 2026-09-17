import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sourceFrontmatter} from './source-format.js';
const fail = message => {throw Object.assign(new Error(message),{code:'UNSUPPORTED_INDEX'});};
const hash = value => createHash('sha256').update(value).digest('hex');
const fieldsV1=['page_id','vector'];
const fieldsV2=['chunk_id','page_id','chunk_index','chunk_text','heading_path','vector'];
const scalar = value => `'${value.replaceAll("'","''")}'`;
const rowFingerprint = rows => hash(JSON.stringify(rows.map(row=>({...row,vector:Buffer.from(new Float32Array(row.vector).buffer).toString('hex')}))));
function checkWritePath(root,names) {
  if(process.platform!=='win32')return;
  // 固定 Lance 依赖在 Windows 上的临时文件提交不支持长路径；为生成的数据文件名留出余量。
  for(const name of names)if(path.join(root,'.llm-wiki/lancedb',`${name}.lance`,'data','0'.repeat(64)+'.lance').length>=260)
    fail('Windows LanceDB 写入路径过长；请将备份与演练工作目录移到更短的库外路径，再重新生成方案');
}
function normalizedRows(rows,chunked) {
  return rows.map(row=>Object.fromEntries((chunked?fieldsV2:fieldsV1).map(name=>[name,name==='vector'?Array.from(row[name]):row[name]])))
    .sort((a,b)=>(a.chunk_id??a.page_id).localeCompare(b.chunk_id??b.page_id));
}
async function readTable(db,name) {
  const table=await db.openTable(name); const schema=await table.schema();
  const chunked=name==='wiki_chunks_v2', expected=chunked?fieldsV2:fieldsV1;
  if(schema.metadata.size || JSON.stringify(schema.fields.map(f=>f.name))!==JSON.stringify(expected))fail('向量表字段或元数据不是固定上游格式');
  for(const field of schema.fields) {
    if(field.nullable || field.metadata.size)fail('向量表字段约束或元数据未知');
    if(field.name==='vector') {
      const child=field.type.children?.[0];
      if(field.type.toString()!==`FixedSizeList[${field.type.listSize}]<Float32>` || !Number.isInteger(field.type.listSize) || field.type.listSize<1 || child?.type.toString()!=='Float32' || child.name!=='item' || !child.nullable || child.metadata.size)fail('向量必须为固定维度 Float32 列');
    } else if(field.type.toString()!==(field.name==='chunk_index'?'Uint32':'Utf8'))fail('向量表列类型不是上游格式');
  }
  const rows=normalizedRows(await table.query().toArray(),chunked), ids=new Set();
  for(const row of rows) {
    const id=chunked?row.chunk_id:row.page_id;
    if(typeof row.page_id!=='string'||!row.page_id||[...row.page_id].length>256||/["'\/\\\p{Cc}\p{Cf}\u2028\u2029]/u.test(row.page_id)||ids.has(id)||!row.vector.every(Number.isFinite))fail('向量行存在空标识、重复标识或非法值');
    if(chunked && (!Number.isInteger(row.chunk_index)||row.chunk_index<0||row.chunk_id!==`${row.page_id}#${row.chunk_index}`||typeof row.chunk_text!=='string'||typeof row.heading_path!=='string'))fail('分块标识或内容不满足上游约束');
    ids.add(id);
  }
  return {table,rows,chunked};
}
export async function analyzeIndexes({baseline,root,moves,changes}) {
  if(baseline.files.some(file=>file.path.includes('/.cache/')))fail('源旁缓存尚未验证，禁止迁移');
  const pageMoves=moves.filter(move=>move.from.startsWith('wiki/')).map(move=>({from:path.posix.basename(move.from,'.md'),to:path.posix.basename(move.to,'.md')}));
  // API revision 混合了全文与模型配置签名；不能冒充内容哈希或沿用已失效签名。
  for(const file of changes.keys()) if(file.startsWith('wiki/')) {
    const revision=`.llm-wiki/embedding-revisions/${hash(path.posix.basename(file,'.md'))}.revision`;
    if(baseline.files.some(item=>item.path===revision))fail('受影响页面存在 API embedding revision；缺少有效配置签名时拒绝，保留既有向量');
  }
  const diskFiles=baseline.files.filter(file=>file.path.startsWith('.llm-wiki/lancedb/')).map(file=>file.path);
  if(!diskFiles.length)return {status:'absent',tables:[],knownStatePaths:[],pageMoves:[]};
  if(diskFiles.some(file=>!/^\.llm-wiki\/lancedb\/(wiki_vectors|wiki_chunks_v2)\.lance\//.test(file)))fail('向量目录包含未知数据库或格式');
  checkWritePath(root,[...new Set(diskFiles.map(file=>file.split('/')[2].replace(/\.lance$/,'')))]);
  try {
    const {connect}=await import('@lancedb/lancedb');
    const db=await connect(path.join(root,'.llm-wiki/lancedb'));
    const names=await db.tableNames();
    if(!names.length||names.some(name=>!['wiki_vectors','wiki_chunks_v2'].includes(name)))fail('向量表名称未知');
    const tables=[];
    for(const name of names) {
      const {rows}=await readTable(db,name);
      for(const pageId of new Set(rows.map(row=>row.page_id))) {
        const pages=baseline.files.filter(file=>file.path.startsWith('wiki/')&&file.path.endsWith('.md')&&path.posix.basename(file.path,'.md')===pageId);
        if(pages.length!==1)fail('索引页面不存在或 stem 对应多个页面，不能猜测来源');
        if(changes.has(pages[0].path)) {
          const original=await readFile(path.join(root,pages[0].path),'utf8');
          if(sourceFrontmatter(original).body!==sourceFrontmatter(changes.get(pages[0].path)).body)fail('正文修复影响已有索引片段，尚未验证片段迁移，保留该材料');
        }
      }
      if(new Set(pageMoves.map(move=>move.to)).size!==pageMoves.length)fail('最终摘要向量标识重复');
      for(const move of pageMoves) if(move.from!==move.to&&rows.some(row=>row.page_id===move.to)&&!pageMoves.some(other=>other.from===move.to))fail('目标摘要向量标识已存在');
      tables.push({name,rows,baselineHash:rowFingerprint(rows),affectedRows:rows.filter(row=>pageMoves.some(move=>move.from===row.page_id)).length});
    }
    return {status:'ready',tables,knownStatePaths:diskFiles,pageMoves};
  } catch(error) {if(error.code==='UNSUPPORTED_INDEX')throw error;fail('无法读取受支持的 LanceDB 格式，原数据保持不变');}
}
export function indexPlanReport(plan) {return {status:plan.status,tables:plan.tables.map(({name,affectedRows})=>({name,affectedRows})),pageMoves:plan.pageMoves};}
export async function verifyIndexContents(root,expected) {
  if(expected.status==='absent')return {status:'absent',tables:[]};
  const {connect}=await import('@lancedb/lancedb');
  const db=await connect(path.join(root,'.llm-wiki/lancedb')), tables=[];
  for(const prior of expected.tables) {
    const current=await readTable(db,prior.name);
    if(rowFingerprint(current.rows)!==prior.baselineHash)fail('恢复索引与备份的全部行及向量不一致');
    const searched=[];
    for(const pageId of new Set(current.rows.map(row=>row.page_id))) {
      const row=current.rows.find(row=>row.page_id===pageId);
      const found=await current.table.vectorSearch(row.vector).where(`page_id = ${scalar(pageId)}`).limit(1).toArray();
      if(found[0]?.page_id!==pageId)fail('恢复索引重新打开后无法检索既有页面');
      searched.push(pageId);
    }
    tables.push({name:prior.name,rows:current.rows.length,vectorsPreserved:true,searched});
  }
  return {status:'verified',tables};
}
export async function executeIndexMigration(root,plan) {
  if(plan.status==='absent')return {status:'absent',tables:[]};
  checkWritePath(root,plan.tables.map(table=>table.name));
  const {connect}=await import('@lancedb/lancedb');
  const location=path.join(root,'.llm-wiki/lancedb');
  const db=await connect(location), reports=[];
  for(const expected of plan.tables) {
    const {table,rows,chunked}=await readTable(db,expected.name);
    if(rowFingerprint(rows)!==expected.baselineHash)fail('索引在审核后变化');
    const temporary=plan.pageMoves.filter(move=>move.from!==move.to).map(move=>({...move,temp:`organizer-${randomUUID()}`}));
    for(const move of temporary) if(rows.some(row=>row.page_id===move.temp))fail('临时向量标识发生冲突');
    // 先将所有旧标识移到独占临时标识，避免交换或链式映射覆盖后续条件。
    for(const move of temporary) for(const row of rows.filter(row=>row.page_id===move.from)) {
      await table.update({where:chunked?`chunk_id = ${scalar(row.chunk_id)}`:`page_id = ${scalar(row.page_id)}`,values:chunked?{page_id:move.temp,chunk_id:`${move.temp}#${row.chunk_index}`}:{page_id:move.temp}});
    }
    for(const move of temporary) for(const row of rows.filter(row=>row.page_id===move.from)) {
      await table.update({where:chunked?`chunk_id = ${scalar(`${move.temp}#${row.chunk_index}`)}`:`page_id = ${scalar(move.temp)}`,values:chunked?{page_id:move.to,chunk_id:`${move.to}#${row.chunk_index}`}:{page_id:move.to}});
    }
    const reopened=await connect(location);
    const actual=await readTable(reopened,expected.name);
    const transformed=normalizedRows(rows.map(row=>{
      const move=plan.pageMoves.find(move=>move.from===row.page_id);
      return !move?row:{...row,page_id:move.to,...(chunked?{chunk_id:`${move.to}#${row.chunk_index}`}:{})};
    }),chunked);
    if(rowFingerprint(actual.rows)!==rowFingerprint(transformed))fail('索引迁移未保持所有向量与无关行逐值一致');
    const searchable=[];
    for(const move of plan.pageMoves) {
      const source=rows.find(row=>row.page_id===move.from); if(!source)continue;
      const matches=await actual.table.vectorSearch(source.vector).where(`page_id = ${scalar(move.to)}`).limit(1).toArray();
      if(!matches.length||matches[0].page_id!==move.to)fail('重新打开索引后无法检索迁移页面');
      searchable.push(move.to);
    }
    reports.push({name:expected.name,rows:actual.rows.length,affectedRows:expected.affectedRows,vectorsPreserved:true,reopenedSearch:searchable});
  }
  return {status:'verified',tables:reports};
}

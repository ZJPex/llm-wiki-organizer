// 主题标签只描述附加主题，不参与目标目录生成。
export function themeTags(value=[]){
 if(!Array.isArray(value)||value.length>12||value.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>80||/[\x00-\x1f]/.test(tag)))throw new Error('主题标签须为最多12个非空短文本');
 return [...new Set(value.map(tag=>tag.trim()))];
}

export function completeSuggestion(source){
 return Boolean(source.analysis&&!source.analysis.uncertain&&['body','navigation'].includes(source.kind??source.analysis.kind)
  &&(source.confirmedName??source.suggestion??source.analysis.suggestion)&&typeof source.classification?.category==='string'
  &&source.classification.finalPath);
}

export function suggestionProgress(sources){
 const result={total:sources.length,complete:0,needsClassification:0,needsInformation:0,failed:0,pending:0};
 for(const source of sources){
  if(source.status?.endsWith('failed'))result.failed++;
  else if(completeSuggestion(source))result.complete++;
  else if(source.status==='needs-information'||source.status==='blocked'||source.analysis?.uncertain)result.needsInformation++;
  else if(source.analysis)result.needsClassification++;
  else result.pending++;
 }
 return result;
}

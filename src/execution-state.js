// 各入口允许的终态不同，但对授权、写入证据和现场的识别共用一处。
export function executionBlock(batch,action){
 const application=batch.flow?.historyApplication;
 if(action==='refresh'&&application&&!['complete','failed'].includes(application.status))return 'application';
 for(const slice of batch.slices??[]){
  const complete=slice.status==='complete',cancelled=slice.status==='cancelled',applying=slice.status==='applying';
  const original=!!slice.originalResultPath,journal=!!slice.originalJournalPath,archive=!!slice.archiveResult;
  const blocked={review:applying||(!complete&&(original||archive)),refresh:applying||(!complete&&(original||journal||archive)),history:applying||slice.status==='authorized'||original||(archive&&!complete&&!cancelled),archive:!complete&&!cancelled};
  if(!(action in blocked))throw new Error('未知执行现场策略');
  if(blocked[action])return 'slice';
 }
 return null;
}

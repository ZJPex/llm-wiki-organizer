export async function loadReview(batch, request) {
  const sources = [], nodes = [];
  let cursor = 0;
  do {
    const page = await request('get', { batchId: batch.batchId, cursor, limit: 50 });
    if (page.revision !== batch.revision) throw new Error('批次已变化，请重新读取后生成全量审核清单');
    sources.push(...page.sources); cursor = page.nextCursor;
  } while (cursor !== null);
  let treeCursor = 0;
  do {
    const page = await request('get', { batchId: batch.batchId, treeCursor, limit: 50 });
    if (page.revision !== batch.revision || page.flow.tree?.status !== 'approved') throw new Error('分类树尚未审核或已变化，请重新审核');
    nodes.push(...page.flow.tree.nodes); treeCursor = page.flow.tree.nextCursor;
  } while (treeCursor !== null);
  return { batchId: batch.batchId, revision: batch.revision, sources, nodes };
}

export function reviewReason(source) {
  if (!['analyzed', 'reviewed'].includes(source.status)) return source.skipReason || '尚未完成分析或已保留原处';
  if (source.ingestStatus !== 'historical') return '关联不明确或属于新增材料';
  if (!source.analysis || source.analysis.uncertain || !source.proposedNodeId) return '分析证据或分类不足';
  if (!source.confirmedName && !source.analysis.suggestion) return '缺少有效文件名建议，请先单独审核';
  return '';
}

// 逐项复用现有校验；失败后读取新版本再继续，无法读取时立即停止。
export async function confirmReview(preview, rows, request, update) {
  let revision = preview.revision, confirmed = 0;
  const failures = [];
  for (const row of rows) {
    if (!row.include && !row.wasSelected) continue;
    try {
      const batch = await request('reviewItem', { batchId: preview.batchId, revision, sourceId: row.sourceId,
        action: row.include ? 'confirm' : 'exclude', name: row.name, nodeId: row.nodeId });
      revision = batch.revision; if (row.include) confirmed++; update(batch);
    } catch (error) {
      failures.push({ identity: row.identity, reason: error.message });
      if (['STALE_BATCH', 'BATCH_BUSY'].includes(error.code)) throw new Error('批次被其他操作更新，已停止；请重新生成全量审核清单');
      const batch = await request('get', { batchId: preview.batchId });
      if (error.revision !== batch.revision) throw new Error('失败后批次版本无法核对，已停止；请重新生成全量审核清单');
      revision = batch.revision; update(batch);
      if (row.wasSelected) throw new Error('已有审核方案修改失败，已停止；请检查该材料原有审核结果后继续');
    }
  }
  return { confirmed, failures };
}

// 串行提交小批请求，使用服务端全库统计，不受材料列表分页影响。
export async function analyzeAll({ getBatch, request, update, stopped }) {
  while (!stopped()) {
    const before = getBatch();
    if (!before.analysisProgress.remaining) return 'complete';
    const next = await request('analyzeNext', {
      batchId: before.batchId, revision: before.revision, limit: 5, stopOnFailure: true,
    });
    update(next);
    if (!next.analysisProgress.remaining) return 'complete';
    if (next.analysisProgress.remaining >= before.analysisProgress.remaining) {
      throw new Error('分析未取得新进展，已停止。请检查材料状态后重试。');
    }
  }
  return 'paused';
}

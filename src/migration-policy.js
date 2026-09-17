const reject = (code, message) => { throw Object.assign(new Error(message), { code }); };

// 后续链接、共享产出及索引适配分别替换这些独立策略；默认拒绝未覆盖状态。
export function rejectComplexLinks({ documents }) {
  for (const document of documents) if (/\[\[|\]\(|^\s*\[[^\]]+\]:|\b(?:href|src)\s*=/m.test(document.text)) reject('UNSUPPORTED_LINKS', '发现双链、Markdown、引用式或 HTML 链接，需后续链接迁移支持');
}
export function rejectSharedOutputs({ cache, oldIdentity, outputs, relativeOutput }) {
  for (const [identity, other] of Object.entries(cache.entries)) {
    if (identity !== oldIdentity && (!Array.isArray(other.filesWritten) || other.filesWritten.some(file => outputs.includes(relativeOutput(file))))) reject('SHARED_OUTPUT', '发现共享产出，需要后续共享关联迁移能力');
  }
}
export function rejectIndexes({ baseline }) {
  if (baseline.files.some(file => file.path.startsWith('.llm-wiki/lancedb/') || file.path.includes('/.cache/'))) reject('UNSUPPORTED_INDEX', '存在尚未验证的向量索引或源旁缓存，拒绝当前迁移');
}

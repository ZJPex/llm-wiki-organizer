// 空字符串表示 Raw 根分类；不能将它与没有推荐的 null 混为一谈。
export function canConfirmRecommendedCategory(source) {
 return source.status==='classified'&&!source.selected&&Boolean(source.confirmedName)
  &&['new','historical'].includes(source.ingestStatus)&&['body','navigation'].includes(source.kind)
  &&Boolean(source.analysis)&&!source.analysis.uncertain&&!source.evolution
  &&source.classification?.status==='needs-review'&&typeof source.classification.category==='string';
}

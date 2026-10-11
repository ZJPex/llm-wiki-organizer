// 审核依据与整批进度版本分开，进度写入不撤销用户所见的正文和分类依据。
export const reviewBasis=source=>({sourceHash:source.hash,currentPath:source.currentPath,reviewVersion:source.reviewVersion??0,catalogHash:source.classification?.catalogHash??null,proposalHash:source.classification?.newCategory?.proposalHash??null,rulesHash:source.classification?.rulesHash??source.frozenPlan?.rulesHash??null});
export const sameReviewBasis=(source,basis)=>!!basis&&Object.entries(reviewBasis(source)).every(([key,value])=>basis[key]===value);

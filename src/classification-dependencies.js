import {planDigest} from './categories.js';

// 检索只读路径和同义名，选择只读实际候选；新增提议还读取完整目录说明。
const search=catalog=>catalog.categories.map(({path,aliases})=>({path,aliases}));
const metadata=(catalog,paths)=>paths.map(path=>catalog.categories.find(category=>category.path===path)??null);
export function classificationDependency(catalog,classification,{selected=false,fullCatalog=false}={}){
 if(classification.newCategory||fullCatalog)return {schemaVersion:1,kind:'full-catalog',catalogHash:catalog.hash};
 if(selected){
  const parts=classification.category.split('/'),paths=[''];for(let i=1;i<=parts.length;i++)if(parts.slice(0,i).join('/'))paths.push(parts.slice(0,i).join('/'));
  return {schemaVersion:1,kind:'selected-target',paths,metadataHash:planDigest(metadata(catalog,paths))};
 }
 const paths=classification.considered??[];
 return {schemaVersion:1,kind:'recommendation',searchHash:planDigest(search(catalog)),paths,metadataHash:planDigest(metadata(catalog,paths))};
}
export function classificationStillValid(dependency,catalog){
 if(dependency?.schemaVersion!==1)return false;
 if(dependency.kind==='full-catalog')return dependency.catalogHash===catalog.hash;
 if(!['selected-target','recommendation'].includes(dependency.kind)||!Array.isArray(dependency.paths)||metadata(catalog,dependency.paths).some(value=>!value))return false;
 if(dependency.metadataHash!==planDigest(metadata(catalog,dependency.paths)))return false;
 return dependency.kind==='selected-target'||dependency.searchHash===planDigest(search(catalog));
}
export function revalidatedClassification(classification,frozenPlan,catalog){
 if(!classificationStillValid(classification?.dependency,catalog))return null;
 const proof={fromCatalogHash:classification.catalogHash,toCatalogHash:catalog.hash,dependencyHash:planDigest(classification.dependency)};
 const next={classification:{...classification,catalogHash:catalog.hash,catalogProof:proof,options:catalog.categories.map(category=>category.path)}};
 if(frozenPlan){const {planHash,...unsigned}=frozenPlan;if(planDigest(unsigned)!==planHash)return null;const frozen={...unsigned,catalogHash:catalog.hash,catalogProof:proof};next.frozenPlan={...frozen,planHash:planDigest(frozen)};}
 return next;
}

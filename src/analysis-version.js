import {createHash} from 'node:crypto';
// 切段、提示语义、汇总或证据规则改变时递增；并发设置不参与版本。
export const ANALYSIS_RULE_VERSION='full-text-analysis-v1';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function analysisVersion(config){
 const semantic=config?Object.fromEntries(['provider','model','customEndpoint','apiMode','customHeaders','maxContextSize','localCliIsolation','apiKey'].filter(key=>config[key]!==undefined).map(key=>[key,config[key]])):null;
 return {rules:ANALYSIS_RULE_VERSION,fingerprint:createHash('sha256').update(JSON.stringify(canonical(semantic))).digest('hex')};
}
export const sameAnalysisVersion=(first,second)=>first?.rules===second.rules&&first?.fingerprint===second.fingerprint;

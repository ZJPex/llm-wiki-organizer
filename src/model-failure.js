// 所有出口共用有限重试规则；凭据、地址和服务端正文不进入错误。
export const MODEL_RETRY_POLICY=Object.freeze({attempts:3,baseDelayMs:250,maxDelayMs:2000});
const definitions={MODEL_RATE_LIMITED:['模型服务限流，等待后重试',true,false],MODEL_AUTH_FAILED:['模型鉴权失败，请修正配置后重试',false,true],MODEL_QUOTA_EXHAUSTED:['模型服务额度不足，请恢复额度后重试',false,true],MODEL_TEMPORARY_FAILURE:['模型服务暂时不可用，稍后重试',true,false],MODEL_RESPONSE_INVALID:['模型响应格式无效，请检查模型后重试',false,false],MODEL_REQUEST_FAILED:['模型调用失败，请检查配置后重试',false,false],MODEL_ARTICLE_STOPPED:['所属文章已失败，未启动更多请求；可重试补齐缺口',false,false]};
export function modelFailure(code,{status,retryAfterMs}={}){const [message,retryable,shared]=definitions[code]??definitions.MODEL_REQUEST_FAILED;return Object.assign(new Error(message),{code,retryable,shared,...(status?{status}:{}),...(Number.isFinite(retryAfterMs)?{retryAfterMs:Math.max(0,Math.min(MODEL_RETRY_POLICY.maxDelayMs,retryAfterMs))}:{})});}
export function failureFromHttp(response){
 const status=response.status,code=status===429?'MODEL_RATE_LIMITED':[401,403].includes(status)?'MODEL_AUTH_FAILED':status===402?'MODEL_QUOTA_EXHAUSTED':status>=500||[408,425].includes(status)?'MODEL_TEMPORARY_FAILURE':'MODEL_REQUEST_FAILED';
 const retryAfter=response.headers.get('retry-after'),milliseconds=/^\d+(\.\d+)?$/.test(retryAfter??'')?Number(retryAfter)*1000:Date.parse(retryAfter)-Date.now();
 return modelFailure(code,{status,retryAfterMs:milliseconds});
}
export function safeModelFailure(error){
 if(error?.code==='ANALYSIS_PAUSED')return error;
 if(definitions[error?.code])return modelFailure(error.code,error);
 if(['TypeError','AbortError','TimeoutError'].includes(error?.name)||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN'].includes(error?.code))return modelFailure('MODEL_TEMPORARY_FAILURE');
 return modelFailure('MODEL_REQUEST_FAILED');
}

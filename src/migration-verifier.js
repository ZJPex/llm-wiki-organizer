import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const execute = promisify(execFile);
export const UPSTREAM_COMMIT = 'e8082119649e6a8e1cf85eaf289adcabfdf39d4e';

// 二进制位置只从启动环境读取，网页不能传命令、参数模板或可执行文件。
export function nativeRescanVerifier(binary = process.env.ORGANIZER_RESCAN_BINARY) {
  return async ({ validationPath, projectId }) => {
    if (!binary || !path.isAbsolute(binary)) throw Object.assign(new Error('尚未配置已构建的原生上游重扫验证器'), { code: 'VERIFIER_UNAVAILABLE' });
    const { stdout } = await execute(binary, ['--validation-copy', validationPath, projectId], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  };
}

export function requireQuietRescan(proof) {
  if (proof?.upstreamCommit !== UPSTREAM_COMMIT || !Array.isArray(proof?.result?.changedTasks) || !Array.isArray(proof?.events) || !Array.isArray(proof?.result?.queue?.tasks)) throw Object.assign(new Error('上游重扫证据格式或版本无效'), { code: 'INVALID_RESCAN_PROOF' });
  if (proof.result.changedTasks.length || proof.events.some(event => event.event === 'file-sync://changed') || proof.result.queue.tasks.some(task => ['pending', 'processing'].includes(task.status))) throw Object.assign(new Error('真实上游重扫发现新增变更或摄取风险'), { code: 'RESCAN_CHANGED' });
  return proof;
}

export function modelGuard() {
  const attempts = [];
  const deny = kind => async () => { attempts.push({ kind, at: new Date().toISOString() }); throw Object.assign(new Error('迁移禁止调用模型'), { code: 'MODEL_FORBIDDEN' }); };
  return { attempts, generate: deny('generation'), vision: deny('vision'), embed: deny('embedding') };
}

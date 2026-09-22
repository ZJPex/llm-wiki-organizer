import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

// Windows 杀毒、索引或只读进度查询可能短暂持有目标文件；保持原子替换，不先删除日志。
export async function atomicRename(from, to, { renameFile = rename, wait = setTimeout, platform = process.platform } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameFile(from, to); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      await wait(Math.min(25 * 2 ** attempt, 500));
    }
  }
}

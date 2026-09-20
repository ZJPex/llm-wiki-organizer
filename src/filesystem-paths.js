import path from 'node:path';
import { realpath } from 'node:fs/promises';

// 先解析最近的现有祖先，兼容尚未创建的目标及 Windows 短路径别名。
export async function canonicalPath(input) {
  const absolute = path.resolve(input);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(absolute) === absolute) throw error;
    return path.join(await canonicalPath(path.dirname(absolute)), path.basename(absolute));
  }
}

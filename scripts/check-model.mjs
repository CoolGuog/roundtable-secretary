import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configuredHttpModel } from '../apps/api/dist/secretary-access.js';
import { SecretaryService } from '../apps/api/dist/secretary.js';

// 主动发起一次真实模型调用；只使用虚构日程，不读取用户数据库或个人记忆。
try {
  const env = { ...parseEnv(fs.readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8')), ...process.env };
  if (env.SECRETARY_MODE !== 'http' || !env.SECRETARY_API_KEY?.trim()) throw new Error('请先运行 npm.cmd run model:setup，在本机配置 Key');
  const service = new SecretaryService('http', configuredHttpModel(env));
  const date = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10), start = Date.now();
  const result = await service.draft(`${date}下午三点到四点讨论课程项目`, []);
  if (result.status === 'UNAVAILABLE') throw new Error(result.message);
  if (result.status !== 'READY' || result.date !== date || result.startTime !== '15:00' || result.endTime !== '16:00') throw new Error('模型已响应，但日程字段未通过检查；请检查模型名称或重试');
  console.log(`真实模型连接与草稿解析通过，耗时 ${((Date.now() - start) / 1000).toFixed(1)} 秒。未创建日程。`);
} catch (error) {
  // 仅允许应用层已脱敏的诊断；绝不输出上游响应体或堆栈。
  const message = error instanceof Error ? error.message : '';
  const safe = /^(请先运行|模型|暂时无法|http 模式需要|SECRETARY_MODEL|SECRETARY_BASE_URL)/.test(message) && message.length < 160;
  console.error(safe ? message : '连接验证未完成，请检查本机模型配置与网络；未输出敏感信息。'); process.exitCode = 1;
}

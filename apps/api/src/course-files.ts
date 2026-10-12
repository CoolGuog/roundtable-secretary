import { BadRequestException, HttpException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export type CourseFile = { originalname: string; buffer: Buffer; size: number };
export const MAX_COURSE_FILE = 4 * 1024 * 1024;
let active = false;
export function validateCourseFile(file: CourseFile | undefined) {
  if (!file?.buffer?.length || file.buffer.length > MAX_COURSE_FILE) throw new BadRequestException('请选择不超过4MB的课表文件');
  const extension = file.originalname.toLowerCase().split('.').pop();
  const head = file.buffer;
  const valid = extension === 'png' ? head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : ['jpg','jpeg'].includes(extension!) ? head[0] === 255 && head[1] === 216 && head[2] === 255
    : extension === 'pdf' ? head.subarray(0,5).toString() === '%PDF-'
    : extension === 'xlsx' ? head.subarray(0,4).equals(Buffer.from([80,75,3,4]))
    : extension === 'csv' ? !head.includes(0) : false;
  if (!valid) throw new BadRequestException('文件格式不符；支持PNG、JPG、PDF、XLSX、UTF-8 CSV，旧版XLS请另存为XLSX');
  return extension!;
}

/** 单任务、独立线程、超时强制终止；原文件不落盘。 */
export async function extractCourseFile(file: CourseFile | undefined) {
  const extension = validateCourseFile(file);
  if (active) throw new HttpException('正在识别另一份课表，请稍后重试', 429);
  active = true;
  try {
    return await new Promise<{ text: string; notes: string[] }>((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'course-file-worker.js'), { workerData: { buffer: file!.buffer, extension }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      const timer = setTimeout(() => { reject(new BadRequestException('识别超时，请裁剪图片或拆分PDF后重试')); void worker.terminate(); }, 90000);
      worker.once('message', result => {
        clearTimeout(timer); void worker.terminate();
        if (result.error) reject(new BadRequestException(result.error)); else resolve(result);
      });
      worker.once('error', () => { clearTimeout(timer); reject(new BadRequestException('文件无法识别，请检查格式或换用清晰截图')); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new BadRequestException('文件处理已停止，请缩小文件后重试')); });
    });
  } finally { active = false; }
}

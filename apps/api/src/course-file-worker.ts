import { parentPort, workerData } from 'node:worker_threads';
import { createWorker } from 'tesseract.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import ExcelJS from 'exceljs';
import { fromBuffer } from 'yauzl';
import { Readable } from 'node:stream';

const LIMIT = 12000;
const checkText = (text: string) => {
  if (text.length > LIMIT) throw Error('课表文字超过12000字，请按页或工作表拆分');
  if (!text.trim()) throw Error('没有识别到文字，请换用更清晰的文件');
  return text;
};
async function ocr(buffer: Buffer) {
  const image = await loadImage(buffer);
  if (!image.width || !image.height || image.width * image.height > 12000000) throw Error('图片过大，请裁剪到1200万像素以内');
  const language = require('@tesseract.js-data/chi_sim');
  const worker = await createWorker('chi_sim', 1, {
    langPath: language.langPath, cacheMethod: 'none', gzip: true,
    errorHandler: () => {},
  });
  try {
    const result = await worker.recognize(buffer);
    return result.data.text;
  } finally { await worker.terminate(); }
}
async function validateZip(buffer: Buffer) {
  await new Promise<void>((resolve, reject) => fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(Error('XLSX文件损坏')); return; }
    let total = 0, count = 0;
    zip.on('error', () => { zip.close(); reject(Error('XLSX文件损坏')); });
    zip.on('entry', entry => {
      total += entry.uncompressedSize;
      if (++count > 2000 || total > 20000000) { zip.close(); reject(Error('表格解压后过大，请只保留课表工作表')); return; }
      zip.readEntry();
    });
    zip.on('end', resolve); zip.readEntry();
  }));
}
async function extract() {
  const buffer = Buffer.from(workerData.buffer), extension = workerData.extension;
  const notes: string[] = [];
  let text = '';
  if (extension === 'xlsx' || extension === 'csv') {
    const book = new ExcelJS.Workbook();
    if (extension === 'xlsx') { await validateZip(buffer); await book.xlsx.load(buffer as any); }
    else { new TextDecoder('utf-8', { fatal: true }).decode(buffer); await book.csv.read(Readable.from([buffer])); }
    if (book.worksheets.length > 5) throw Error('最多识别5个工作表，请删除无关工作表后上传');
    for (const sheet of book.worksheets) {
      if (sheet.rowCount > 300 || sheet.columnCount > 40) throw Error('表格超过300行或40列，请只保留课表区域');
      text += `\n工作表：${sheet.name}\n`;
      sheet.eachRow((row, index) => {
        const cells: string[] = [];
        row.eachCell(cell => { if (cell.type === ExcelJS.ValueType.Formula) throw Error('请把公式转换为文本或数值后上传'); cells.push(`${cell.address}: ${cell.text}`); });
        text += `第${index}行 | ${cells.join(' | ')}\n`;
        if (text.length > LIMIT) throw Error('课表文字超过12000字，请拆分文件');
      });
    }
    notes.push('已保留单元格位置；请核对合并单元格对应的星期和节次。');
  } else if (extension === 'pdf') {
    const pdfjs = await (new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')() as Promise<any>);
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, stopAtErrors: true });
    try {
      const document = await task.promise;
      if (document.numPages > 3) throw Error('PDF最多3页，请拆分后上传');
      for (let i = 1; i <= document.numPages; i++) {
        const page = await document.getPage(i), content = await page.getTextContent();
        const items = content.items.filter((item: any) => typeof item.str === 'string');
        let pageText = items.map((item: any) => `[x${Math.round(item.transform[4])},y${Math.round(item.transform[5])}] ${item.str}`).join('\n');
        if (items.reduce((n: number, item: any) => n + item.str.trim().length, 0) < 15) {
          const viewport = page.getViewport({ scale: 1.8 });
          if (viewport.width * viewport.height > 12000000) throw Error('PDF页面过大，请裁剪后上传');
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
          pageText = await ocr(canvas.toBuffer('image/png'));
          notes.push(`第${i}页为扫描页，使用文字识别，请仔细核对。`);
        }
        if (!pageText.trim()) throw Error('没有识别到文字，请删除空白页或换用更清晰的文件');
        text += `\n第${i}页（PDF坐标y越大越靠上）\n${pageText}\n`;
        checkText(text);
      }
    } finally { await task.destroy(); }
  } else {
    text = await ocr(buffer);
    notes.push('图片文字识别可能错字或错列，请对照原图核对课程、星期、节次。');
  }
  return { text: checkText(text), notes };
}
extract().then(result => parentPort!.postMessage(result)).catch(error => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(课表文字|没有识别|图片过大|XLSX文件|表格解压|最多识别|表格超过|请把公式|PDF最多|PDF页面)/.test(message);
  parentPort!.postMessage({ error: safe ? message : '文件识别失败，请检查文件是否损坏、加密，CSV请使用UTF-8编码' });
});

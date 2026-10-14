import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { extractCourseFile, validateCourseFile } from '../apps/api/dist/course-files.js';
import { createApp } from '../apps/api/dist/app.js';
import { existsSync } from 'node:fs';
const upload = (buffer, originalname) => ({ buffer: Buffer.from(buffer), originalname, size: buffer.length });
const pdf = (jpeg) => {
  const content=jpeg ? 'q 380 0 0 104 10 50 cm /Image1 Do Q' : 'BT /F1 16 Tf 40 160 Td (Monday Math 08:30-10:00) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  if (jpeg) { objects[2]=objects[2].replace('/Font << /F1 4 0 R >>','/Font << /F1 4 0 R >> /XObject << /Image1 6 0 R >>'); objects.push(`<< /Type /XObject /Subtype /Image /Width 1100 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${jpeg.toString('latin1')}\nendstream`); }
  let text='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(text,'latin1'));text+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const start=Buffer.byteLength(text,'latin1'); text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text,'latin1');
};
test('格式签名、大小和旧XLS限制', () => {
  assert.throws(()=>validateCourseFile(upload(Buffer.from('fake'),'课程.pdf')),/格式/);
  assert.throws(()=>validateCourseFile(upload(Buffer.alloc(4*1024*1024+1),'a.csv')),/4MB/);
  assert.throws(()=>validateCourseFile(upload(Buffer.from('test'),'课程.xls')),/XLS/);
});
test('XLSX和CSV保留行列位置，公式拒绝识别', async () => {
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('课表');sheet.addRow(['星期','课程','时间']);sheet.addRow(['周一','高等数学','08:30—10:00']);
  const result=await extractCourseFile(upload(await book.xlsx.writeBuffer(),'课程.xlsx'));
  assert.match(result.text,/B2: 高等数学/);
  assert.match((await extractCourseFile(upload(Buffer.from('星期,课程\n周二,英语'),'课程.csv'))).text,/英语/);
  sheet.getCell('A4').value={formula:'1+1',result:2};
  await assert.rejects(extractCourseFile(upload(await book.xlsx.writeBuffer(),'课程.xlsx')),/公式/);
});
test('PDF文字提取以及本机中文OCR', {timeout:90000}, async () => {
  const result=await extractCourseFile(upload(pdf(),'课程.pdf')); assert.match(result.text,/Monday Math/);
  const canvas=createCanvas(1100,300), ctx=canvas.getContext('2d');
  const font='C:/Windows/Fonts/msyh.ttc'; if(existsSync(font)) GlobalFonts.registerFromPath(font,'CourseTest');
  ctx.fillStyle='white';ctx.fillRect(0,0,1100,300);ctx.fillStyle='black';ctx.font='40px CourseTest';
  ctx.fillText('星期一 高等数学 08:30-10:00',30,100);ctx.fillText('星期二 大学英语 14:00-15:30',30,200);
  const image=await extractCourseFile(upload(canvas.toBuffer('image/png'),'课程.png'));
  assert.match(image.text,/08[：:]30/); assert.match(image.text,/数\s*学|英\s*语/);
  const scanned=await extractCourseFile(upload(pdf(canvas.toBuffer('image/jpeg')),'扫描课表.pdf'));
  assert.match(scanned.text,/08[：:]30/); assert.ok(scanned.notes.some(note=>note.includes('扫描')));
});
test('上传接口鉴权、拒绝伪文件、识别CSV不调用模型不保存日程', async () => {
  let calls=0;
  const app=await createApp({storage:'memory',authMode:'demo',secretary:{mode:'http',model:{name:'test',complete:async()=>{calls++;return {items:[],notes:['测试']};}}}});
  try {
    await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const {token}=await(await fetch(base+'/dev/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'文件测试'})})).json();
    const send=(name,text,auth=true)=>{const form=new FormData();form.append('file',new Blob([text]),name);return fetch(base+'/me/secretary/course-file',{method:'POST',headers:auth?{Authorization:`Bearer ${token}`}:{},body:form});};
    assert.equal((await send('a.csv','课程,时间',false)).status,401);
    assert.equal((await send('a.pdf','fake')).status,400);
    const response=await send('a.csv','课程,时间\n数学,08:30');assert.equal(response.status,201);assert.match((await response.json()).text,/数学/);
    assert.equal(calls,0);
    assert.deepEqual(await(await fetch(base+'/me/arrangements',{headers:{Authorization:`Bearer ${token}`}})).json(),[]);
  } finally {await app.close();}
});

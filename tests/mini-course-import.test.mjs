import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function page(confirm = true, overrides = {}) {
  let p, uploads=0, calls=0;
  const api={today:()=> '2026-10-12',modeLabel:()=> '测试',errorMessage:e=>e.message,
    uploadCourseFile:async()=>{uploads++;return {text:'周一 数学 08:30',notes:['核对原图']};},
    courseDraftsFromText:async()=>{calls++;return {items:[{title:'数学'}],notes:['请补充结束时间'],model:'test'};},
    courseDraftsFromImage:async()=>{calls++;return {items:[{title:'图片课程'}],notes:[],model:'vision'};},...overrides};
  const js=ts.transpileModule(fs.readFileSync('apps/miniprogram/src/pages/secretary/index.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(js,{exports:{},require:()=>api,Page:v=>p=v,wx:{showModal:async()=>({confirm}),chooseMedia:async()=>({tempFiles:[{tempFilePath:'/tmp/photo.jpg',size:200}]}),chooseMessageFile:async()=>({tempFiles:[{path:'/tmp/file.pdf',name:'课表.pdf',size:200}]})}});
  p.setData=values=>Object.assign(p.data,values);
  return {p,uploads:()=>uploads,calls:()=>calls};
}
test('未同意上传不访问文件；识别后保留可核对文字，不自动调用模型',async()=>{
  const no=page(false);await no.p.chooseCourseFile({currentTarget:{dataset:{kind:'file'}}});assert.equal(no.uploads(),0);
  const yes=page();await yes.p.chooseCourseFile({currentTarget:{dataset:{kind:'file'}}});assert.equal(yes.uploads(),1);assert.equal(yes.calls(),0);assert.match(yes.p.data.courseText,/数学/);assert.equal(yes.p.data.extracting,false);
});
test('图片选择后只预览、不上传OCR，确认整理才调用视觉模型',async()=>{
  const c=page();await c.p.chooseCourseFile({currentTarget:{dataset:{kind:'image'}}});
  assert.equal(c.uploads(),0);assert.equal(c.calls(),0);assert.equal(c.p.data.courseImagePath,'/tmp/photo.jpg');
  await c.p.generateCourses();assert.equal(c.calls(),1);assert.equal(c.p.data.batch[0].title,'图片课程');assert.equal(c.p.data.batch[0].saved,false);
});
test('核对后生成草稿而非保存，缺文字阻止调用，迟到结果不覆盖页面',async()=>{
  const c=page();await c.p.generateCourses();assert.equal(c.calls(),0);
  c.p.data.courseText='周一 数学';await c.p.generateCourses();assert.equal(c.calls(),1);assert.equal(c.p.data.batch[0].saved,false);
  let finish;const late=page(true,{courseDraftsFromText:()=>new Promise(resolve=>finish=resolve)});late.p.data.courseText='数学';const running=late.p.generateCourses();await new Promise(setImmediate);late.p._draftEpoch++;finish({items:[{title:'迟到'}],notes:[],model:'test'});await running;assert.equal(late.p.data.batch.length,0);
});

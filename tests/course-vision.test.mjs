import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpModel, courseSemester } from '../apps/api/dist/secretary.js';
import { createApp } from '../apps/api/dist/app.js';

test('图片以多模态内容传入，保留跨格规则、不加入提示词或返回密钥', async () => {
  const image='data:image/png;base64,iVBORw0KGgo=';let sent;
  const model=new HttpModel({baseUrl:'https://api.deepseek.com',apiKey:'fake-secret',model:'deepseek-flash',fetcher:async (_url,options)=>{
    sent=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({items:[],notes:['待补充']})}}]}));
  }});
  await model.complete({text:'看课表',today:'2026-10-12',memories:[],batch:true,courses:true,image});
  assert.equal(sent.messages[1].content[1].image_url.url,image);
  assert.match(sent.messages[0].content,/跨多节的同一个色块只生成一条/);
  assert.ok(!JSON.stringify(sent).includes('fake-secret'));
});

test('看图接口要求登录，拒绝非图片和过长说明，只生成草稿', async()=>{
  const seen=[];
  const app=await createApp({storage:'memory',authMode:'demo',secretary:{mode:'http',model:{name:'vision-test',complete:async request=>{
    seen.push(request);return {semesterStart:'2026-09-07',items:[{title:'创业基础',date:null,startTime:'10:20',endTime:'11:50',repeatKind:'weekly',weekdays:[0],weekdayNames:['周一'],until:null}],notes:['待确认']};
  }}}});
  try {
    await app.listen(0,'127.0.0.1');const url=await app.getUrl();
    const {token}=await(await fetch(url+'/dev/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'看图测试'})})).json();
    const png=Buffer.from([137,80,78,71,13,10,26,10]);
    const send=(name,bytes,context='',auth=true)=>{const form=new FormData();form.append('file',new Blob([bytes]),name);form.append('context',context);return fetch(url+'/me/secretary/course-image',{method:'POST',headers:auth?{Authorization:`Bearer ${token}`}:{},body:form});};
    assert.equal((await send('课表.png',png,'',false)).status,401);
    assert.equal((await send('a.csv','课程,时间')).status,400);
    assert.equal((await send('a.png',png,'a'.repeat(1001))).status,400);
    const response=await send('a.png',png);assert.equal(response.status,201);const result=await response.json();
    assert.equal(result.items[0].endTime,'11:50');assert.equal(result.items[0].date,'2026-09-07');assert.equal(result.items[0].until,'2027-01-07');
    assert.deepEqual(result.items[0].weekdays,[1]);
    assert.equal(seen.length,1);assert.equal(seen[0].image,'data:image/png;base64,'+png.toString('base64'));assert.deepEqual(seen[0].memories,[]);
    assert.ok(!JSON.stringify(result).includes('base64'));
    assert.deepEqual(await(await fetch(url+'/me/arrangements',{headers:{Authorization:`Bearer ${token}`}})).json(),[]);
  } finally {await app.close();}
});
test('学期预填优先来源日期，四个月跨年与月末正确，原有单条日期规则不变',()=>{
  assert.equal(courseSemester({semesterStart:'2026-09-07'},'2026-10-12').end,'2027-01-07');
  assert.equal(courseSemester({semesterStart:'2026-10-31'},'2026-10-12').end,'2027-02-28');
  assert.equal(courseSemester({},'2026-10-12').start,'2026-09-01');
  assert.equal(courseSemester({},'2027-01-02').start,'2026-09-01');
  assert.equal(courseSemester({semesterStart:'2026-09-07',semesterEnd:'2027-01-29'},'2026-10-12').end,'2027-01-29');
});

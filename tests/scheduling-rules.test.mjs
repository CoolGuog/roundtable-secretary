import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulingRules,evaluateRules} from '../apps/api/dist/scheduling-rules.js';
const memory=content=>({category:'CONSTRAINT',label:'可校验安排规则',content});
const slot={date:'2026-10-17',startTime:'14:00',endTime:'15:00'};
test('只识别明确模板，不自动把自然文字变为硬限制；娱乐规则不影响会议',()=>{
 assert.equal(schedulingRules([memory('娱乐活动：仅周末安排')],false).length,0);
 assert.equal(schedulingRules([memory('尽量周末出去玩')],true).length,0);
 const rules=schedulingRules([memory('娱乐活动：仅周末安排')],true);
 assert.ok(evaluateRules(slot,[],rules)[0].passed);
 assert.equal(evaluateRules({...slot,date:'2026-10-16'},[],rules)[0].passed,false);
});
test('缓冲边界、跨午夜以及当天无安排按程序校验',()=>{
 const rules=schedulingRules([memory('所有活动：前后各留出60分钟')],true);
 assert.ok(evaluateRules(slot,[{date:slot.date,startTime:'12:00',endTime:'13:00'}],rules)[0].passed);
 assert.equal(evaluateRules(slot,[{date:slot.date,startTime:'12:00',endTime:'13:01'}],rules)[0].passed,false);
 assert.equal(evaluateRules({...slot,startTime:'00:30',endTime:'01:30'},[{date:'2026-10-16',startTime:'23:00',endTime:'23:45'}],rules)[0].passed,false);
 const empty=schedulingRules([memory('所有活动：当天无其他安排')],false);
 assert.equal(evaluateRules(slot,[{date:slot.date,startTime:'08:00',endTime:'09:00'}],empty)[0].passed,false);
 assert.ok(evaluateRules(slot,[],empty)[0].passed);
});

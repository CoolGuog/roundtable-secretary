import { PersonalMemory } from './memory';
import { Arrangement } from './store';
import { Slot } from './negotiation';
import { beijingInstant } from './time';

// 仅识别用户明确保存的规则模板，不把自然语言偏好偷偷提升为硬限制。
export function schedulingRules(memories: PersonalMemory[], leisure: boolean) {
  return memories.filter(m=>m.category==='CONSTRAINT' && m.label==='可校验安排规则').flatMap(m=>{
    const match=/^(所有活动|娱乐活动)：(仅周末安排|仅周六安排|当天无其他安排|前后各留出(\d+)分钟)$/.exec(m.content);
    if(!match || match[1]==='娱乐活动'&&!leisure)return [];
    const buffer=match[3]===undefined?0:Number(match[3]);
    if(buffer>240)return [];
    return [{text:m.content,kind:match[2],buffer}];
  });
}
export function evaluateRules(slot: Slot, items: Arrangement[], rules: ReturnType<typeof schedulingRules>) {
  const weekday=new Date(slot.date+'T00:00:00Z').getUTCDay();
  const start=beijingInstant(slot.date,slot.startTime).getTime(),end=beijingInstant(slot.date,slot.endTime).getTime();
  return rules.map(rule=>({text:rule.text,passed:rule.kind==='仅周末安排'?weekday===0||weekday===6:rule.kind==='仅周六安排'?weekday===6:rule.kind==='当天无其他安排'?!items.some(item=>item.date===slot.date):!items.some(item=>beijingInstant(item.date,item.startTime).getTime()<end+rule.buffer*60000 && start-rule.buffer*60000<beijingInstant(item.date,item.endTime).getTime())}));
}

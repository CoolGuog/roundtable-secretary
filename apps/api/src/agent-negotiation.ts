import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PersonalStore, inputObject } from './store';
import { SecretaryModel, ModelRequestError } from './secretary';
import { Room } from './rooms';
import { Slot } from './negotiation';
import { beijingDate, beijingInstant } from './time';
import { schedulingRules, evaluateRules } from './scheduling-rules';

export const AGENT_NEGOTIATION = Symbol('agent-negotiation');
type Consent = { userId: string; memberId: string; expires: number; busyStamp: string | null; shareDetails:boolean };
type Event = { speaker: string; text: string; round: number };
class AgentFlowError extends Error {}
type Run = { id: string; version: number; created: number; leisure:boolean; activityKind:string; status: 'RUNNING'|'READY'|'NO_AGREEMENT'|'FAILED'; events: Event[]; message: string; slot?: Slot; proposalId?: string; explanations?:Record<string,string[]> };
const keys = (value: unknown, expected: string[]) => { const body = inputObject(value); if (Object.keys(body).some(key => !expected.includes(key))) throw new BadRequestException('不支持额外字段'); return body; };

/** 单进程Demo运行状态；授权与过程24小时失效，重启清空，日程仍由原有持久化确认流程写入。 */
export class AgentNegotiation {
  private consents = new Map<string, Map<string, Consent>>();
  private runs = new Map<string, Run>();
  private active = 0;
  constructor(private readonly store: PersonalStore, private readonly model: SecretaryModel | null) {}
  onModuleDestroy() { for (const run of this.runs.values()) if (run.status === 'RUNNING') { run.status='FAILED';run.message='后台正在关闭，协商已停止'; } }
  private prune() {
    const before = Date.now() - 86400000;
    for (const [id, run] of this.runs) if (run.created < before && run.status !== 'RUNNING') this.runs.delete(id);
    for (const [id, entries] of this.consents) { for (const [member, consent] of entries) if (consent.expires < Date.now()) entries.delete(member); if (!entries.size) this.consents.delete(id); }
  }
  private authorized(room: Room, memberId: string) {
    const member = room.members.find(m => m.id === memberId), consent = this.consents.get(room.id)?.get(memberId);
    return member?.shareBusy && consent && consent.expires > Date.now() && consent.busyStamp === member.consentUpdatedAt ? consent : undefined;
  }
  async status(userId: string, roomId: string) {
    this.prune(); const room = await this.store.rooms.get(userId, roomId), run = this.runs.get(roomId);
    return { enabled: Boolean(this.model), isOwner: room.isOwner, roomOpen: room.status === 'OPEN', ownDetailsAuthorized: Boolean(this.authorized(room,room.members.find(m=>m.isMe)!.id)?.shareDetails), members: room.members.map(member => ({ name: member.name, isMe: member.isMe, shareBusy: member.shareBusy, authorized: Boolean(this.authorized(room, member.id)) })),
      run: run ? run.version === room.version && room.members.every(member => this.authorized(room, member.id)) ? { id: run.id, status: run.status, events: run.events, message: run.message, slot: run.slot, proposalId: run.proposalId, activityKind:run.activityKind, explanation:run.explanations?.[userId]||[] } : { id: run.id, status:'FAILED', events:[], message:'成员或授权已变化，旧协商不再有效；请重新授权并协商' } : null };
  }
  async consent(userId: string, roomId: string, value: unknown) {
    const input = keys(value, ['enabled','shareDetails']); if (typeof input.enabled !== 'boolean'||input.shareDetails!==undefined&&typeof input.shareDetails!=='boolean') throw new BadRequestException('请明确授权或撤回');
    const room = await this.store.rooms.get(userId, roomId), member = room.members.find(m => m.isMe)!;
    if (input.enabled && (room.status !== 'OPEN' || !member.shareBusy)) throw new BadRequestException('请先在圆桌详情授权本次忙闲');
    this.prune();
    if (!this.consents.has(roomId) && this.consents.size >= 200) throw new HttpException('授权数量已达上限，请稍后重试',429);
    const entries = this.consents.get(roomId) || new Map<string, Consent>();
    const running=this.runs.get(roomId);
    if(running?.status==='RUNNING'){running.status='FAILED';running.message='秘书授权已变化，协商已停止，请重新开始';}
    if (input.enabled) entries.set(member.id, { userId, memberId: member.id, expires: Date.now()+86400000, busyStamp: member.consentUpdatedAt, shareDetails:input.shareDetails===true });
    else { entries.delete(member.id); const run = this.runs.get(roomId); if (run?.status === 'RUNNING') { run.status='FAILED';run.message='成员撤回授权，协商已停止'; } }
    this.consents.set(roomId, entries); return this.status(userId, roomId);
  }
  private async check(userId: string, roomId: string, run: Run) {
    const room = await this.store.rooms.get(userId, roomId);
    if (run.status !== 'RUNNING' || Date.now()-run.created > 360000 || room.status !== 'OPEN' || room.version !== run.version || !room.members.every(member => this.authorized(room, member.id))) throw new Error('授权或圆桌已变化');
    return room;
  }
  async start(userId: string, roomId: string, value: unknown) {
    const input=keys(value, ['activityKind']);
    if(input.activityKind!==undefined&&!['leisure','meeting','other'].includes(String(input.activityKind)))throw new BadRequestException('请选择活动类型');
    this.prune();
    const room = await this.store.rooms.get(userId, roomId);
    if (!room.isOwner) throw new ForbiddenException('请由圆桌发起人启动协商');
    if (!this.model) throw new BadRequestException('需要先在后台接入真实模型');
    if (room.status !== 'OPEN' || room.members.length < 2 || room.members.length > 5 || !room.members.every(member => this.authorized(room, member.id))) throw new BadRequestException('需要2至5位成员，且全员授权忙闲及个人秘书');
    const last = this.runs.get(roomId);
    if (last?.status === 'RUNNING') return this.status(userId, roomId);
    if (last && Date.now()-last.created < 60000) throw new HttpException('请间隔一分钟再启动协商',429);
    if (this.active >= 2 || this.runs.size >= 200 && !last) throw new HttpException('秘书协商繁忙，请稍后重试',429);
    const proposal = await this.store.negotiation.currentProposal(userId, roomId);
    if (proposal?.status === 'OPEN' && !proposal.stale) throw new BadRequestException('已有待确认方案，请先完成或撤回');
    // await后再检查，避免两个并发启动重复消耗模型与创建方案。
    if (this.runs.get(roomId)?.status === 'RUNNING') return this.status(userId, roomId);
    if (this.active >= 2) throw new HttpException('秘书协商繁忙，请稍后重试',429);
    const run: Run = { id: randomUUID(), version: room.version, created: Date.now(), leisure:input.activityKind==='leisure', activityKind:input.activityKind==='leisure'?'娱乐活动':input.activityKind==='meeting'?'学习会议':'其他活动', status:'RUNNING', events:[], message:'各位秘书正在协商，尚未写入日程' };
    this.runs.set(roomId,run); this.active++;
    void this.execute(userId,room,run).catch(error => {
      if(run.status !== 'RUNNING')return;
      run.status='FAILED';
      const reason=error instanceof AgentFlowError ? error.message : error instanceof ModelRequestError ? ({TIMEOUT:'模型响应超时',AUTH:'后台模型密钥无效或无权限',BALANCE:'模型账户余额不足',RATE_LIMIT:'模型请求过于频繁',FORMAT:'模型未返回有效的协商动作',NETWORK:'后台暂时无法连接模型'}[error.code] || '模型服务暂时不可用') : '授权、圆桌或日程发生变化，或后台处理失败';
      run.message=`${reason}。没有自动写入日程，请重试或手动选时。`;
    }).finally(()=>this.active--);
    return this.status(userId,roomId);
  }
  private candidates(room: Room) {
    const slots: Slot[]=[];
    const minutes=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3));
    const clock=(n:number)=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
    for(let day=Date.parse(room.dateFrom+'T00:00:00Z');day<=Date.parse(room.dateTo+'T00:00:00Z');day+=86400000) {
      const date=new Date(day).toISOString().slice(0,10);
      for(let t=minutes(room.startTime);t+room.durationMinutes<=minutes(room.endTime);t+=30) {
        if(beijingInstant(date,clock(t)).getTime()>Date.now()) slots.push({date,startTime:clock(t),endTime:clock(t+room.durationMinutes)});
      }
    }
    if(slots.length<=216)return slots;
    return Array.from({length:216},(_,index)=>slots[Math.floor(index*(slots.length-1)/215)]);
  }
  private async availability(consent: Consent, room: Room, slots: Slot[], leisure:boolean) {
    // 缓冲检查也读取边界前后一天，避免跨午夜漏掉相邻日程。
    const shift=(date:string,n:number)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
    const items=await this.store.list(consent.userId,shift(room.dateFrom,-1),shift(room.dateTo,1));
    const rules=schedulingRules(await this.store.listMemories(consent.userId),leisure);
    const available=slots.map(slot=>!items.some(item=>item.date===slot.date && item.startTime<slot.endTime && slot.startTime<item.endTime) && evaluateRules(slot,items,rules).every(result=>result.passed));
    return {available,rules};
  }
  private async execute(userId: string, room: Room, run: Run) {
    const slots=this.candidates(room);
    if(!slots.length){run.status='NO_AGREEMENT';run.message='没有可供协商的未来时段，请修改圆桌范围';return;}
    let offer: number|null=null;
    const privateReasons:Record<string,string>={};
    const histories: Array<Array<Record<string,unknown>>> = room.members.map(()=>[]);
    for(let round=1;round<=5;round++) {
      const roundChoices:number[]=[];
      for(let memberIndex=0;memberIndex<room.members.length;memberIndex++) {
        await this.check(userId,room.id,run);
        const member=room.members[memberIndex], consent=this.authorized(room,member.id)!;
        const speaker=`${member.name}的秘书`, tools: Record<string,unknown>={};
        let selected: number|null=null, answered=false, feedback='';
        for(let step=0;step<5;step++) {
          await this.check(userId,room.id,run);
          const action=await this.model!.complete({text:'',today:beijingDate(new Date()),memories:[],agent:{ title:room.title, goal:room.goal, activityKind:run.activityKind, scheduleReadAllowed:consent.shareDetails, round, maxRounds:5, candidates:slots.map((slot,index)=>({...slot,index,weekday:['周日','周一','周二','周三','周四','周五','周六'][new Date(slot.date+'T00:00:00Z').getUTCDay()]})), offer, previousFeedback:histories.flatMap((history,index)=>index===memberIndex?[]:history.slice(-1).map(entry=>({...entry,member:index+1}))), ownHistory:histories[memberIndex], tools, feedback }});
          await this.check(userId,room.id,run);
          if(!action)throw new Error('无工具动作');
          if(['read_busy','read_preferences','read_schedule'].includes(String(action.action)) && Object.hasOwn(tools,String(action.action))) {
            feedback='该工具已经读取，结果在tools中（空数组也是有效结果）。不要重复调用；两个工具齐全时立即返回answer。';
            continue;
          }
          if(action.action==='read_busy') {
            const checked=await this.availability(consent,room,slots,run.leisure);
            tools.read_busy=checked.available;
            tools.verified_rule_count=checked.rules.length;
            run.events.push({speaker,round,text:'检查主人忙闲及已设置的可校验规则，仅保留符合条件的候选'});
          } else if(action.action==='read_preferences') {
            tools.read_preferences=(await this.store.listMemories(consent.userId)).filter(m=>m.category!=='NOTE').slice(0,20).map(m=>({category:m.category,label:m.label,content:m.content.slice(0,200)}));
            run.events.push({speaker,round,text:'调用个人偏好工具，结果仅供本人的秘书使用'});
          } else if(action.action==='read_schedule') {
            if(!consent.shareDetails)throw new AgentFlowError('未授权读取日程名称，已阻止该工具调用');
            const items=await this.store.list(consent.userId,room.dateFrom,room.dateTo);
            if(items.length>300)throw new AgentFlowError('日程数量超过本次读取上限，请缩小圆桌日期范围');
            tools.read_schedule=items.map(item=>({title:item.title,date:item.date,startTime:item.startTime,endTime:item.endTime}));
            run.events.push({speaker,round,text:'在本人授权下读取日程名称与时间，结果不向其他成员公开'});
          } else if(action.action==='answer') {
            if(!tools.read_busy || !tools.read_preferences || !['accept','counter','decline'].includes(String(action.decision)))throw new Error('缺少工具结果');
            if(consent.shareDetails&&!Object.hasOwn(tools,'read_schedule')) {feedback='已授权理解课程安排，请先调用read_schedule再提出时间。';continue;}
            if(action.decision==='decline' && action.choice===null) {
              if((tools.read_busy as boolean[]).some(Boolean) && action.reason!=='hard_constraint') {
                feedback='工具表明仍有空闲候选。请按活动性质与偏好比较所有日期，尽量/优先是软偏好，先找更符合偏好的替代时间。仅当全部空闲候选违反主人明确的不可妥协限制时才decline并返回reason:"hard_constraint"；否则选最符合偏好的可用时段。';
                continue;
              }
              answered=true;break;
            }
            if(!Number.isInteger(action.choice) || Number(action.choice)<0 || Number(action.choice)>=slots.length || !(tools.read_busy as boolean[])[Number(action.choice)] || (action.decision==='accept' && action.choice!==offer) || action.decision==='decline') {
              feedback='刚才的回答无效：accept/counter的choice必须是候选index整数且read_busy[index]为true。offer为null表示没有提议，必须counter一个具体时段，不能accept null。accept只能接受当前非空offer。请重新选择符合偏好的可用时段。';
              continue;
            }
            privateReasons[consent.userId]=typeof action.explanation==='string'?action.explanation.slice(0,240):'';
            selected=Number(action.choice);answered=true;break;
          } else throw new Error('不允许的工具');
        }
        if(!answered)throw new AgentFlowError('秘书重复读取工具或在仍有空闲候选时未提出时间，已停止以避免继续消耗模型用量');
        histories[memberIndex].push({choice:selected,decision:selected===null?'decline':selected===offer?'accept':'counter'});
        if(selected===null){run.events.push({speaker,round,text:'当前候选均忙碌，或秘书判断有不可妥协的限制，需主人核对'});run.status='NO_AGREEMENT';run.message=`在 ${room.dateFrom} 至 ${room.dateTo} 的候选中未找到满足安排和明确限制的时间。请核对偏好、扩大日期范围或手动选时；不会自动超出授权范围。`;return;}
        const slot=slots[selected];
        const weekday=['周日','周一','周二','周三','周四','周五','周六'][new Date(slot.date+'T00:00:00Z').getUTCDay()];
        run.events.push({speaker,round,text:`${selected===offer?'同意':'建议'} ${slot.date}（${weekday}）${slot.startTime}—${slot.endTime}`});
        roundChoices.push(selected);
        offer=selected;
        if(roundChoices.length===room.members.length && roundChoices.every(choice=>choice===selected)) {
          await this.check(userId,room.id,run);
          const explanations:Record<string,string[]>={};
          for(const m of room.members){
            const own=this.authorized(room,m.id)!;
            const checked=await this.availability(own,room,[slot],run.leisure);
            if(!checked.available[0])throw new AgentFlowError('日程或可校验规则已变化，方案未生成');
            explanations[own.userId]=['生成方案时未与本人的已有安排重叠',...checked.rules.map(rule=>'已校验：'+rule.text),...(privateReasons[own.userId]?['模型建议理由（需核对）：'+privateReasons[own.userId]]:[]),'各位秘书选择了同一候选；普通文字偏好由模型参考，尚不保证全部满足。'];
          }
          await this.check(userId,room.id,run);
          const proposal=await this.store.negotiation.createProposal(userId,room.id,{...slot,remark:'秘书协商生成；全员确认后生效。'});
          run.explanations=explanations;run.slot=slot;run.proposalId=proposal.id;run.status='READY';run.message='秘书已达成一致，已生成待确认方案。请所有成员返回圆桌亲自接受，全员确认后才写入日程。';return;
        }
      }
    }
    run.status='NO_AGREEMENT';run.message='5轮协商仍未达成一致，请主人调整范围或手动选时间';
  }
}

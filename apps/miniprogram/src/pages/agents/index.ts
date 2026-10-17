import { request, errorMessage } from '../../services/secretary';
type State = { enabled: boolean; isOwner: boolean; roomOpen: boolean; members: Array<{ name:string; isMe:boolean; shareBusy:boolean; authorized:boolean }>; run: null | { status:string; message:string; events:Array<{speaker:string;text:string;round:number}> } };
Page({
  data:{ id:'', state:null as State|null, error:'', busy:false, authorized:false, activityIndex:0, activityNames:['学习会议','娱乐活动','其他活动'], shareDetails:false },
  _timer: undefined as number|undefined, _visible:false, _epoch:0, _reading:false,
  onLoad(query:Record<string,string>){this.setData({id:query.id||''});},
  onShow(){this._visible=true;void this.reload();},
  onHide(){this._visible=false;this._epoch++;if(this._timer!==undefined)clearTimeout(this._timer);this._timer=undefined;this.setData({busy:false});},
  onUnload(){this.onHide();},
  onFeedbackDismiss(){this.setData({error:''});},
  onActivity(event:WechatMiniprogram.PickerChange){this.setData({activityIndex:Number(event.detail.value)});},
  onDetails(event:WechatMiniprogram.SwitchChange){this.setData({shareDetails:event.detail.value});},
  async reload(){
    if(!this._visible||this._reading)return;
    if(this._timer!==undefined)clearTimeout(this._timer);
    this._reading=true;const epoch=this._epoch;
    try{const state=await request<State>(`/roundtables/${encodeURIComponent(this.data.id)}/agents`,'GET');if(epoch!==this._epoch)return;this.setData({state,authorized:state.members.find(m=>m.isMe)?.authorized||false});}
    catch(error){if(epoch===this._epoch)this.setData({state:null,error:errorMessage(error)});}
    finally{this._reading=false;if(this._visible)this._timer=setTimeout(()=>void this.reload(),3000);}
  },
  async consent(){
    if(this.data.busy)return;
    const enabled=!this.data.authorized;
    const answer=await wx.showModal({title:enabled?'授权个人秘书':'撤回秘书授权',content:enabled?`允许读取圆桌日期前后各一天的忙闲（用于缓冲校验）及最多20条偏好/限制。${this.data.shareDetails?'同时向模型发送本人日程名称和时间，用于理解课程附近、课后等要求。':'不发送日程名称，无法据此辨认课程。'}个人内容不向其他成员公开。授权24小时有效，后台重启需重新授权。`:'停止后续工具读取；已发送到模型的信息无法撤回。已生成的方案可在圆桌详情撤回。'});
    if(!answer.confirm)return;await this.action('consent','PUT',{enabled,shareDetails:enabled&&this.data.shareDetails});
  },
  async start(){
    if(this.data.busy)return;
    const answer=await wx.showModal({title:'启动各位秘书协商',content:'最多5轮，可能进行多次模型调用并消耗用量。达成一致后只生成待确认方案，不会替任何人接受。'});
    if(answer.confirm)await this.action('start','POST',{activityKind:['meeting','leisure','other'][this.data.activityIndex]});
  },
  async action(path:string,method:'PUT'|'POST',body:object){
    if(this.data.busy)return;this.setData({busy:true,error:''});const epoch=++this._epoch;
    try{const state=await request<State>(`/roundtables/${encodeURIComponent(this.data.id)}/agents/${path}`,method,body);if(epoch===this._epoch)this.setData({state,authorized:state.members.find(m=>m.isMe)?.authorized||false});}
    catch(error){if(epoch===this._epoch)this.setData({error:errorMessage(error)});}
    finally{if(epoch===this._epoch)this.setData({busy:false});}
  },
  back(){wx.navigateBack();},
});

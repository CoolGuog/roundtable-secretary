import {request,errorMessage} from '../../services/secretary';
import {getRoom,isLocalRoomMode,Proposal} from '../../services/roundtables';
type Note={id:string;name:string;content:string;createdAt:string;timeLabel?:string};
const label=(date:string)=>new Date(Date.parse(date)+8*3600000).toISOString().slice(0,16).replace('T',' ');
Page({
 data:{id:'',content:'',notes:[] as Note[],history:[] as Array<Proposal & {timeLabel:string;statusLabel:string}>,busy:false,loading:false,open:false,error:''},
 _epoch:0,
 onLoad(query:Record<string,string>){this.setData({id:query.id||''});},
 onShow(){void this.reload();},onHide(){this._epoch++;this.setData({busy:false,loading:false});},onUnload(){this._epoch++;},
 onFeedbackDismiss(){this.setData({error:''});},onContent(event:WechatMiniprogram.Input){this.setData({content:event.detail.value});},
 async reload(){
  if(this.data.busy)return;const epoch=++this._epoch;this.setData({loading:true,error:''});
  try{
   const room=await getRoom(this.data.id);const local=isLocalRoomMode();
   const notes:Note[]=local?(wx.getStorageSync('roundtable.notes.'+this.data.id)||[]):await request<Note[]>(`/roundtables/${this.data.id}/notes`,'GET');
   const history=local?[]:await request<Proposal[]>(`/roundtables/${this.data.id}/proposal-history`,'GET');
   if(epoch!==this._epoch)return;
   this.setData({open:room.status==='OPEN',notes:[...notes].reverse().map(n=>({...n,timeLabel:label(n.createdAt)})),history:history.map(p=>({...p,timeLabel:label(p.createdAt),statusLabel:p.stale?'已失效':({OPEN:'待全员确认',CONFIRMED:'已确认',REJECTED:'已拒绝',CANCELLED:'已撤回',EXPIRED:'已失效'})[p.status]}))});
  }catch(error){if(epoch===this._epoch)this.setData({open:false,notes:[],history:[],error:errorMessage(error)});}
  finally{if(epoch===this._epoch)this.setData({loading:false});}
 },
 async save(){
  if(this.data.busy||this.data.loading||!this.data.open)return;
  const content=this.data.content.trim();if(!content)return;
  const epoch=this._epoch;this.setData({busy:true,error:''});
  try{
   if(isLocalRoomMode()){
    const key='roundtable.notes.'+this.data.id;const notes:Note[]=wx.getStorageSync(key)||[];
    if(notes.length>=100)throw new Error('备注已达到100条上限');
    wx.setStorageSync(key,[...notes,{id:String(Date.now()),name:'我',content,createdAt:new Date().toISOString()}]);
   }else await request(`/roundtables/${this.data.id}/notes`,'POST',{content});
   if(epoch!==this._epoch)return;this.setData({content:'',busy:false});await this.reload();
  }catch(error){if(epoch===this._epoch)this.setData({error:errorMessage(error)+'；若结果不确定，请先刷新核对，避免重复添加。'});}
  finally{if(epoch===this._epoch)this.setData({busy:false});}
 },
});

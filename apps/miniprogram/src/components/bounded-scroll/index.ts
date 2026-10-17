Component({
  properties:{ watchData:{type:null,observer:'measure'}, maxRpx:{type:Number,value:640,observer:'measure'} },
  data:{height:'auto',limit:320,clipped:false},
  lifetimes:{ready(){this._ready=true;this.measure();},detached(){this._ready=false;this._version=Number(this._version||0)+1;}},
  pageLifetimes:{resize(){this.measure();},show(){this.measure();}},
  methods:{
    measure(){
      if(!this._ready)return;
      const version=Number(this._version||0)+1;this._version=version;
      wx.nextTick(()=>{
        if(!this._ready||version!==this._version)return;
        const window=wx.getWindowInfo();
        const limit=Math.max(120,Math.min(Number(this.properties.maxRpx)*window.windowWidth/750,window.windowHeight*0.55));
        this.createSelectorQuery().select('.scroll-content').boundingClientRect((rect:{height:number}|null)=>{
          if(!this._ready||version!==this._version||!rect||Array.isArray(rect))return;
          const content=Math.ceil(rect.height);
          const clipped=content>limit;
          const height=`${Math.min(content,limit)}px`;
          if(height!==this.data.height||clipped!==this.data.clipped||limit!==this.data.limit)this.setData({height,clipped,limit});
        }).exec();
      });
    },
  },
});

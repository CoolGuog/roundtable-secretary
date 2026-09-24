import { clearLocalDemo, modeLabel } from '../../services/secretary';
Page({
  data: { mode: modeLabel() },
  clear() {
    wx.showModal({ title: '清除本机演示数据？', content: '只清除本小程序的本机演示安排与演示会话，不会删除服务器记录。',
      success(result) { if (result.confirm) { clearLocalDemo(); wx.showToast({ title: '已清除', icon: 'success' }); } },
    });
  },
});

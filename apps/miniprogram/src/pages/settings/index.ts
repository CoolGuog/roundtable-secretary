import { clearLocalDemo, modeLabel, loginEnabled, hasLogin, login, logout, errorMessage } from '../../services/secretary';
Page({
  data: { mode: modeLabel(), loginEnabled: loginEnabled(), loggedIn: hasLogin(), busy: false, error: '' },
  onShow() { this.setData({ loggedIn: hasLogin() }); },
  openMemories() { wx.navigateTo({ url: '/pages/memories/index' }); },
  async signIn() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await login(); this.setData({ loggedIn: true }); wx.showToast({ title: '登录成功', icon: 'success' }); }
    catch (error) { this.setData({ error: errorMessage(error), loggedIn: hasLogin() }); }
    finally { this.setData({ busy: false }); }
  },
  async signOut() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await logout(); this.setData({ loggedIn: false }); wx.showToast({ title: '已退出', icon: 'success' }); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
  clear() {
    wx.showModal({ title: '清除本机演示数据？', content: '只清除本小程序的本机演示安排、记忆、圆桌与演示会话，不会删除服务器记录。',
      success(result) { if (result.confirm) { clearLocalDemo(); wx.showToast({ title: '已清除', icon: 'success' }); } },
    });
  },
});

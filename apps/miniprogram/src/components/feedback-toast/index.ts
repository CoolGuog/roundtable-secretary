Component({
  properties: { message: { type: String, value: '', observer: 'display' } },
  data: { visible: false, text: '' },
  lifetimes: { detached() { this.clear(false); } },
  pageLifetimes: { hide() { this.dismiss(); } },
  methods: {
    clear(hide = true) {
      const timer = this._timer as number | undefined;
      if (timer !== undefined) clearTimeout(timer);
      this._timer = undefined;
      if (hide) this.setData({ visible: false });
    },
    display(message: string) {
      if (!message) return;
      const now = Date.now();
      // 立即清空页面绑定，下一次相同操作也能触发；浮窗使用独立text显示。
      this.triggerEvent('dismiss');
      if (now < Number(this._cooldownUntil || 0)) return;
      if (now - Number(this._lastShown || 0) >= 30000 || this._cooldownUntil) {
        this._count = 0; this._cooldownUntil = 0;
      }
      this._lastShown = now;
      this._count = Number(this._count || 0) + 1;
      if (this._count >= 5) this._cooldownUntil = now + 30000;
      this.clear();
      this.setData({ text: message, visible: true });
      this._timer = setTimeout(() => {
        this._timer = undefined;
        this.setData({ visible: false });
      }, 1000);
    },
    dismiss() {
      this.clear();
      this.triggerEvent('dismiss');
    },
  },
});

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
      this.clear();
      if (!message) return;
      this._remaining = 5;
      this.setData({ text: message });
      this.flash();
    },
    flash() {
      this.setData({ visible: true });
      this._timer = setTimeout(() => {
        this._timer = undefined;
        this.setData({ visible: false });
        this._remaining = Number(this._remaining) - 1;
        if (Number(this._remaining) > 0) this._timer = setTimeout(() => { this._timer = undefined; this.flash(); }, 500);
        else this.dismiss();
      }, 1000);
    },
    dismiss() {
      this.clear();
      this._remaining = 0;
      this.triggerEvent('dismiss');
    },
  },
});

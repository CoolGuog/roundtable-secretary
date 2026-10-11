Component({
  properties: { message: { type: String, value: '', observer: 'display' } },
  data: { visible: false, text: '' },
  lifetimes: { detached() { this.clear(false); } },
  pageLifetimes: { hide() { this.clear(); } },
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
      this.setData({ visible: true, text: message });
      this._timer = setTimeout(() => { this._timer = undefined; this.setData({ visible: false }); }, 1000);
    },
  },
});

import { loadSecretaryStatus, request, errorMessage, SecretaryStatus } from '../../services/secretary';
import { sharedEnabled } from '../../services/shared-work';
Page({
  data: { enabled: sharedEnabled(), status: null as (SecretaryStatus & { connectionCheckedAt?: string | null }) | null, busy: false, fresh: false, confirming: false, error: '' },
  _visible: false, _disposed: false, _epoch: 0,
  onShow() { this._visible = true; void this.reload(); },
  onHide() { this._visible = false; this._epoch++; this.setData({ confirming: false, fresh: false }); },
  onUnload() { this._disposed = true; this._visible = false; this._epoch++; },
  async reload() {
    if (!this._visible || this.data.busy) return;
    const epoch = ++this._epoch; this.setData({ busy: true, fresh: false, error: '' });
    try { const status = await loadSecretaryStatus(); if (this._visible && epoch === this._epoch) this.setData({ status, fresh: true }); }
    catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) }); }
    finally { if (!this._disposed) this.setData({ busy: false }); if (this._visible && epoch !== this._epoch) void this.reload(); }
  },
  prepare() { if (this._visible && this.data.fresh && !this.data.busy && this.data.status?.mode === 'http') this.setData({ confirming: true, error: '' }); },
  cancel() { if (!this.data.busy) this.setData({ confirming: false }); },
  async check() {
    if (!this._visible || !this.data.confirming || !this.data.fresh || this.data.busy || this.data.status?.mode !== 'http') return;
    const epoch = ++this._epoch; this.setData({ busy: true, confirming: false, fresh: false, error: '' });
    try { const status = await request<SecretaryStatus>('/me/secretary/connection-check', 'POST', {}); if (this._visible && epoch === this._epoch) this.setData({ status, fresh: true }); }
    catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) + '；未自动重试，请刷新状态后再决定。' }); }
    finally { if (!this._disposed) this.setData({ busy: false }); if (this._visible && epoch !== this._epoch) void this.reload(); }
  },
});

import { isLocalRoomMode } from '../../services/roundtables';
import { errorMessage } from '../../services/secretary';
import { exportLocalBackup, previewLocalBackup, restoreLocalBackup, BackupPreview } from '../../services/local-backup';
const displayTime = (value: string) => new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') + '（北京时间）';
Page({
  data: { local: isLocalRoomMode(), busy: false, error: '', message: '', source: '', fileName: '', ready: false,
    exportedAt: '', exportCounts: [] as BackupPreview['counts'], counts: [] as BackupPreview['counts'], added: 0, preview: false },
  _disposed: false, _epoch: 0, _source: '', _baseline: '', _export: '', _path: '',
  onShow() { this._disposed = false; },
  onHide() { this._baseline = ''; this.setData({ preview: false }); },
  onUnload() { this._disposed = true; this._epoch++; this._source = ''; this._baseline = ''; this._export = ''; },
  generate() {
    if (this.data.busy || !this.data.local || this._disposed) return;
    this.setData({ busy: true, error: '', message: '', ready: false }); this._export = ''; this._path = '';
    try {
      const source = exportLocalBackup(), info = previewLocalBackup(source);
      const fileName = `roundtable-backup-${info.exportedAt.replace(/[:.]/g, '-')}.json`;
      const filePath = `${wx.env.USER_DATA_PATH}/roundtable-local-backup.json`;
      wx.getFileSystemManager().writeFileSync(filePath, source, 'utf8');
      this._export = source; this._path = filePath;
      this.setData({ ready: true, fileName, exportedAt: displayTime(info.exportedAt), exportCounts: info.counts, message: '备份文件已生成。请点“保存备份文件”在微信中选定保存位置；仅留在小程序内仍可能随缓存丢失。' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
  shareFile() {
    if (!this.data.ready || this.data.busy || this._disposed) return;
    this.setData({ busy: true, error: '' }); const epoch = this._epoch;
    const finish = (message = '') => { if (!this._disposed && epoch === this._epoch) this.setData({ busy: false, message }); };
    if (typeof wx.shareFileMessage !== 'function') { finish('当前环境不支持文件保存选择器。可复制小型备份文本，或在支持的微信环境保存文件。'); return; }
    wx.shareFileMessage({ filePath: this._path, fileName: this.data.fileName,
      success: () => finish('文件操作已返回，请确认备份已保存在你选择的位置。'),
      fail: () => finish('未完成文件保存，可重试；开发者工具可能不支持此操作。') });
  },
  copy() {
    if (!this.data.ready || this.data.busy || this._disposed) return;
    if (this._export.length > 60_000) { this.setData({ error: '文本超过 6 万字符，请使用文件备份。' }); return; }
    this.setData({ busy: true, error: '' }); const epoch = this._epoch;
    wx.setClipboardData({ data: this._export,
      success: () => { if (!this._disposed && epoch === this._epoch) this.setData({ message: '备份文本已复制，请粘贴并保存到自己的文件中。' }); },
      fail: () => { if (!this._disposed && epoch === this._epoch) this.setData({ error: '复制失败，请重试或保存文件。' }); },
      complete: () => { if (!this._disposed && epoch === this._epoch) this.setData({ busy: false }); } });
  },
  input(event: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    this._source = ''; this._baseline = ''; this.setData({ source: event.detail.value, preview: false, error: '', message: '' });
  },
  chooseFile() {
    if (this.data.busy || !this.data.local || this._disposed) return;
    this._baseline = ''; this.setData({ busy: true, preview: false, error: '', message: '' }); const epoch = this._epoch;
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['json'],
      success: result => {
        if (this._disposed || epoch !== this._epoch) return;
        try {
          const file = result.tempFiles[0];
          if (!file || file.size > 3_200_000) throw new Error('文件超过备份容量，请选择本应用生成的 JSON 文件');
          const source = wx.getFileSystemManager().readFileSync(file.path, 'utf8');
          if (typeof source !== 'string') throw new Error('无法读取备份文本');
          this.setData({ source: '' }); this.inspect(source);
        } catch (error) { this.setData({ error: errorMessage(error) }); }
      },
      fail: () => { if (!this._disposed && epoch === this._epoch) this.setData({ message: '未选择文件，可重试或粘贴备份文本。' }); },
      complete: () => { if (!this._disposed && epoch === this._epoch) this.setData({ busy: false }); } });
  },
  previewText() { if (!this.data.busy && this.data.local && !this._disposed) this.inspect(this.data.source); },
  inspect(source: string) {
    this._baseline = ''; this._source = ''; this.setData({ preview: false, error: '', message: '' });
    try {
      const result = previewLocalBackup(source); this._baseline = result.baseline; this._source = source;
      this.setData({ preview: true, counts: result.counts, added: result.added, message: `已读取 ${displayTime(result.exportedAt)} 导出的备份，尚未写入。` });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
  },
  cancel() { if (this.data.busy) return; this._source = ''; this._baseline = ''; this.setData({ preview: false, message: '已取消，本机记录未改变。' }); },
  restore() {
    if (!this.data.preview || !this._baseline || this.data.busy || !this.data.local || this._disposed) return;
    this.setData({ busy: true, error: '' });
    try {
      const added = restoreLocalBackup(this._source, this._baseline);
      this._source = ''; this._baseline = ''; this._export = ''; this._path = '';
      this.setData({ preview: false, source: '', ready: false, message: added ? `导入完成，新增 ${added} 份记录。请返回对应页面查看；工作台内的任务和纪要已随圆桌恢复。` : '没有新增内容，相同记录已全部跳过。' });
    } catch (error) { this._baseline = ''; this.setData({ preview: false, error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
});

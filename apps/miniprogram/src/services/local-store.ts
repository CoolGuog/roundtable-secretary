// 六类业务记录共用恢复屏障；追加键以兼容升级前尚未回退的五类日志。
export const localKeys = ['arrangements', 'memories', 'rooms', 'reviews', 'meeting-work', 'recurring'].map(name => `roundtable.demo.${name}.v1`);
const journalKey = 'roundtable.local-restore-journal.v1';
export function recoverLocalRestore() {
  const journal = wx.getStorageSync(journalKey);
  if (!journal) return;
  if (!Array.isArray(journal) || ![5, localKeys.length].includes(journal.length) || journal.some((entry, i) => !entry || entry.key !== localKeys[i] || !Array.isArray(entry.value))) {
    throw new Error('恢复日志损坏，请保留本机数据并联系开发者检查');
  }
  try {
    for (const entry of journal) wx.setStorageSync(entry.key, entry.value);
    wx.removeStorageSync(journalKey);
  } catch { throw new Error('上次导入尚未回退完成，请释放设备空间后重试；暂时停止修改本机记录'); }
}
export function readLocal(key: string): unknown { recoverLocalRestore(); return wx.getStorageSync(key); }
export function writeLocal(key: string, value: unknown) { recoverLocalRestore(); wx.setStorageSync(key, value); }
export function removeLocal(key: string) { recoverLocalRestore(); wx.removeStorageSync(key); }
export function commitLocalRestore(values: unknown[][]) {
  recoverLocalRestore();
  if (values.length !== localKeys.length || values.some(value => !Array.isArray(value))) throw new Error('恢复数据无效');
  const journal = localKeys.map(key => { const value = wx.getStorageSync(key); return { key, value: value || [] }; });
  if (journal.some(entry => !Array.isArray(entry.value))) throw new Error('当前本机记录损坏，请先检查原数据');
  // 先持久化原始记录；同步写入期间无 await，失败或进程中断后仍能恢复。
  wx.setStorageSync(journalKey, journal);
  try {
    localKeys.forEach((key, index) => wx.setStorageSync(key, values[index]));
    wx.removeStorageSync(journalKey);
  } catch {
    recoverLocalRestore();
    throw new Error('导入保存失败，原有记录已恢复；请释放空间后重新预览');
  }
}

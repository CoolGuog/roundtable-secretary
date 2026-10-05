// local 模式不联网，仅在当前设备保存演示数据。
// api 模式连接后台；正式发布使用 wechat 身份与已配置为微信合法域名的 HTTPS 根地址。
export const config: { mode: 'local' | 'api'; authMode: 'demo' | 'wechat'; apiBase: string } = {
  mode: 'local', authMode: 'demo', apiBase: 'http://127.0.0.1:3000',
};

// local 模式不联网，仅在当前设备保存演示数据。
// api 模式仅供本机微信开发者工具与 localhost 演示服务联调。
export const config: { mode: 'local' | 'api'; authMode: 'demo' | 'wechat'; apiBase: string } = {
  mode: 'local', authMode: 'demo', apiBase: 'http://127.0.0.1:3000',
};

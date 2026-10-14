import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/local-store.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
export function withLocalStore(context) {
  const exports = {}; vm.runInNewContext(code, { exports, wx: context.wx });
  const original = context.require; context.require = name => name === './local-store' ? exports : original(name);
  return context;
}

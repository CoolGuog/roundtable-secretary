import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
export function repeatModules(wx) {
  const modules = new Map();
  for (const name of ['repeat-engine', 'local-repeated']) {
    const js = ts.transpileModule(fs.readFileSync(`apps/miniprogram/src/services/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(js, { exports, wx, require: path => modules.get(path) });
    modules.set('./' + name, exports);
  }
  return modules;
}

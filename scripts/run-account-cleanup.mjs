/** Build/run the complete maintenance artifact. Credentials and secret monitor
 * hook URLs come only from a restricted environment; nothing sensitive prints. */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
try {
  const mode = process.argv[2];
  if (process.argv.length > 3 || mode && !['--build', '--monitor'].includes(mode)) throw new Error();
  const names = ['sharing', 'private-media-cache', 'account-cleanup', 'media-maintenance', 'operations'];
  const sources = Object.fromEntries(await Promise.all(names.map(async name => [`./${name}`, await compile(`../apps/web/lib/server/${name}.ts`)])));
  sources['./operations-runtime'] = await readFile(new URL('./operations-runtime.cjs', import.meta.url), 'utf8');
  const runner = `'use strict';
const sources = ${JSON.stringify(sources)};
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  if (!Object.hasOwn(sources, name)) {
    if (['node:crypto', '@supabase/supabase-js'].includes(name)) return require(name);
    throw new Error('Unexpected maintenance dependency');
  }
  const module = { exports: {} }; modules.set(name, module);
  new Function('require', 'module', 'exports', sources[name])(load, module, module.exports);
  return module.exports;
}
(async () => {
  try {
    if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--monitor') throw new Error();
    const runtime = load('./operations-runtime');
    const hooks = runtime.validateOperationsEnvironment(process.env);
    await load('./operations').createOperations({ notify: runtime.createNotifier(hooks) })(process.argv[2] === '--monitor' ? 'monitor' : 'maintenance');
    console.log('Peekalo operations completed.');
  } catch {
    console.error('Peekalo operations incomplete; inspect restricted operational state.');
    process.exitCode = 1;
  }
})();
`;
  if (mode === '--build') {
    const directory = new URL('../apps/web/.next/maintenance/', import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL('account-cleanup.cjs', directory), runner);
    console.log('Portable operations runner built; no credentials included.');
  } else new Function('require', runner)(require);
} catch {
  console.error('Peekalo operations could not prepare; inspect restricted operational state.');
  process.exitCode = 1;
}

/** Repository maintenance CLI. Credentials come only from the process environment;
 * no env files, identifiers or provider responses are printed. REL-05 owns the
 * verified scheduler/alerts/restore drills. Run deliberately with private env:
 * node --env-file=<private-server-env> scripts/run-account-cleanup.mjs
 * Build a portable production runner (TypeScript needed at BUILD time only):
 * node scripts/run-account-cleanup.mjs --build
 * Copy apps/web/.next/maintenance/account-cleanup.cjs beside the deployed web
 * package/node_modules, then run node apps/web/account-cleanup.cjs.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
try {
  if (process.argv.slice(2).some(value => value !== '--build') || process.argv.length > 3) throw new Error('Unsupported maintenance argument');
  const sources = {
    './sharing': await compile('../apps/web/lib/server/sharing.ts'),
    './private-media-cache': await compile('../apps/web/lib/server/private-media-cache.ts'),
    './account-cleanup': await compile('../apps/web/lib/server/account-cleanup.ts'),
  };
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
    const result = await load('./account-cleanup').createAccountCleanup()();
    console.log('Account cleanup: '+result.examined+' examined, '+result.completed+' completed, '+result.pending+' pending.');
    if (result.pending) process.exitCode = 1;
  } catch {
    console.error('Account cleanup could not finish; inspect restricted operational state.');
    process.exitCode = 1;
  }
})();
`;
  if (process.argv[2] === '--build') {
    const directory = new URL('../apps/web/.next/maintenance/', import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL('account-cleanup.cjs', directory), runner);
    console.log('Portable account cleanup runner built; no credentials included.');
  } else new Function('require', runner)(require);
} catch {
  console.error('Account cleanup could not prepare; inspect restricted operational state.');
  process.exitCode = 1;
}

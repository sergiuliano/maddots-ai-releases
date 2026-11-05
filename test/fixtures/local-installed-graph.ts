import assert from 'node:assert/strict';
import {lstat, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ModuleKind, ScriptTarget, preProcessFile, transpileModule} from 'typescript';

const compiledSources = new Map<string, string>();

/** Install the real application graph without redirecting any source import to
 * the checkout. Bare packages use the same installed third-party dependencies
 * as the test process; every helper/shared module and JSON resource is local. */
export async function installLocalCliGraph(helper: string, root: string,
  transform: (source: string, text: string) => string = (_source, text) => text, dependenciesRoot = root): Promise<string[]> {
  const sourceRoot = dirname(helper), visited = new Set<string>(), files: string[] = [], packages = new Set<string>();
  const targetFor = (source: string) => resolve(root, 'dist', relative(helper, source).replace(/\.ts$/, '.js'));
  async function dependency(source: string, specifier: string): Promise<void> {
    if (specifier.startsWith('node:')) return;
    if (specifier.startsWith('.')) return install(resolve(dirname(source), specifier.replace(/\.js$/, '.ts')));
    assert.ok(!specifier.startsWith('file:') && !specifier.startsWith('/'), 'Installed application imports must remain local.');
    const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    if (packages.has(name)) return;
    packages.add(name);
    const require = createRequire(pathToFileURL(source));
    let directory = dirname(require.resolve(specifier));
    while (true) {
      try {
        if (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name === name) break;
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `Installed dependency package ${name} must exist.`);
      directory = parent;
    }
    const target = join(dependenciesRoot, 'node_modules', name);
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    try {await lstat(target);} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await symlink(directory, target, 'dir');
    }
  }
  async function install(source: string): Promise<void> {
    if (visited.has(source)) return;
    assert.ok(source.startsWith(sourceRoot + sep), 'Only the application source graph may be installed.');
    assert.ok(/\.(?:ts|json)$/.test(source), `Unsupported local application dependency ${source}.`);
    visited.add(source);
    const text = transform(source, await readFile(source, 'utf8'));
    let output = text;
    if (!source.endsWith('.json')) {
      const key = source + '\0' + text;
      output = compiledSources.get(key) ?? transpileModule(text, {fileName: source,
        compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext}}).outputText;
      compiledSources.set(key, output);
    }
    const target = targetFor(source);
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    await writeFile(target, output, {mode: 0o600});
    files.push(target);
    if (source.endsWith('.json')) return;
    for (const imported of preProcessFile(output, true).importedFiles) await dependency(source, imported.fileName);
    // The tool matrix loads its JSON through import.meta.url rather than an
    // import declaration. Copy such resources alongside their real importer.
    for (const match of output.matchAll(/new URL\(['"]([^'"]+\.json)['"],\s*import\.meta\.url\)/g)) {
      assert.ok(match[1].startsWith('.'));
      await dependency(source, match[1]);
    }
  }
  await install(join(helper, 'cli.ts'));
  for (const file of files) assert.equal((await lstat(file)).isSymbolicLink(), false);
  return files;
}

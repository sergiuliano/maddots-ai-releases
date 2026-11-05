import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, relative} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
// export-helper rewrites this URL to ../src/config.ts. Derive the source root
// from that one real location rather than granting both layouts an exemption.
const sourceRoot = dirname(fileURLToPath(new URL('../src/config.ts', import.meta.url)));
const sharedRoot = fileURLToPath(new URL('../src/shared/', import.meta.url));
const printer = ts.createPrinter({removeComments: true});
const processMethods = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const hookMethods = new Set(['register', 'registerHooks', '_resolveFilename', '_load']);
const normalize = (path: string) => path.split('\\').join('/');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const printed = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
type Launch = {owner: string; api: string; code: string; hash: string; node: boolean; line: number; syntax: ts.Node};
type Audit = {hooks: string[]; launches: Launch[]; source: ts.SourceFile};

function unwrap(input: ts.Expression): ts.Expression {
  let node = input;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
  return node;
}

/** Bind aliases through the checker, including lexical shadowing, but never
 * execute or import audited code. Unknown module keys are refused. This is a
 * review tripwire, not a general proof for arbitrary obfuscated JavaScript. */
function runtimeAudit(file: string, text: string): Audit {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    /\.[cm]?jsx?$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const host = ts.createCompilerHost({});
  host.getSourceFile = name => name === file ? source : undefined;
  host.fileExists = name => name === file;
  host.readFile = name => name === file ? text : undefined;
  const checker = ts.createProgram([file], {noLib: true, noResolve: true, allowJs: true}, host).getTypeChecker();
  const declarations = (node: ts.Identifier) => checker.getSymbolAtLocation(node)?.declarations ?? [];
  const initializer = (node: ts.Identifier): ts.Expression | undefined => declarations(node).find(
    (declaration): declaration is ts.VariableDeclaration => ts.isVariableDeclaration(declaration) && !!declaration.initializer)?.initializer;
  const literal = (input: ts.Expression | undefined, seen = new Set<ts.Node>()): string | undefined => {
    if (!input) return;
    const node = unwrap(input);
    if (seen.has(node)) return;
    const next = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return literal(initializer(node), next);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left, next), right = literal(node.right, next);
      if (left !== undefined && right !== undefined) return left + right;
    }
    return;
  };
  const property = (node: ts.PropertyName | undefined): string | undefined => !node ? undefined :
    ts.isComputedPropertyName(node) ? literal(node.expression) : ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
  const moduleName = (specifier: string | undefined) => specifier?.replace(/^node:/u, '');
  const imported = (specifier: string | undefined, name?: string): string | undefined => {
    const target = moduleName(specifier);
    if (['module', 'child_process', 'worker_threads', 'process', 'cluster'].includes(target ?? '')) {
      return !name || name === 'default' || target === 'module' && name === 'Module' ? target : `${target}.${name}`;
    }
    if (name && ['runCommand', 'runPackageCommand', 'runToolCommand'].includes(name) && specifier?.startsWith('.')) return `helper.${name}`;
    return;
  };
  const member = (node: ts.Expression) => ts.isPropertyAccessExpression(node) ? node.name.text :
    ts.isElementAccessExpression(node) ? literal(node.argumentExpression) : undefined;
  const receiver = (node: ts.Expression) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;
  const select = (owner: string | undefined, key: string | undefined): string | undefined => !owner ? undefined :
    owner === 'module' && ['Module', 'default', 'constructor'].includes(key ?? '') || owner === 'process' && key === 'mainModule' ?
      'module' : key ? `${owner}.${key}` : `${owner}.<computed>`;
  const capability = (input: ts.Expression | undefined, seen = new Set<ts.Node>()): string | undefined => {
    if (!input) return;
    const node = unwrap(input);
    if (seen.has(node)) return;
    const next = new Set([...seen, node]);
    if (ts.isIdentifier(node)) {
      const value = initializer(node);
      if (value) return capability(value, next);
      for (const declaration of declarations(node)) {
        if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly) {
          const clause = declaration.parent.parent;
          if (!clause.isTypeOnly && ts.isStringLiteral(clause.parent.moduleSpecifier)) {
            return imported(clause.parent.moduleSpecifier.text, (declaration.propertyName ?? declaration.name).text);
          }
        }
        const clause = ts.isImportClause(declaration) ? declaration : ts.isNamespaceImport(declaration) ? declaration.parent : undefined;
        if (clause && !clause.isTypeOnly && ts.isStringLiteral(clause.parent.moduleSpecifier)) return imported(clause.parent.moduleSpecifier.text);
        if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
          const binding = declaration.parent.parent;
          if (ts.isVariableDeclaration(binding)) return select(capability(binding.initializer, next), property(declaration.propertyName ?? declaration.name as ts.PropertyName));
        }
      }
      if (!declarations(node).length && ['process', 'require'].includes(node.text)) return node.text;
      if (!declarations(node).length && ['module', 'Module'].includes(node.text)) return 'module';
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return select(capability(node.expression, next), member(node));
    if (ts.isCallExpression(node)) {
      const target = capability(node.expression, next);
      if (target === 'require' || target === 'module.require' || node.expression.kind === ts.SyntaxKind.ImportKeyword || target === 'process.getBuiltinModule') return imported(literal(node.arguments[0]));
      if (target === 'module.createRequire') return 'require';
      if (member(node.expression) === 'bind') return capability(receiver(node.expression), next);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'promisify') return capability(node.arguments[0], next);
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Reflect' && node.expression.name.text === 'get') return select(capability(node.arguments[0], next), literal(node.arguments[1]));
    }
    return;
  };
  const owner = (node: ts.Node): string => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.getText(source);
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
        (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) return current.name.text;
    }
    return '<top>';
  };
  const hooks = new Set<string>(), launches: Launch[] = [];
  const hook = (node: ts.Node, reason: string) => hooks.add(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${reason}`);
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isImportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly) {
      const declaration = node.parent.parent.parent;
      if (ts.isStringLiteral(declaration.moduleSpecifier) && moduleName(declaration.moduleSpecifier.text) === 'module' &&
        hookMethods.has((node.propertyName ?? node.name).text)) hook(node, 'module hook acquisition');
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) &&
      moduleName(node.moduleSpecifier.text) === 'module' && (!node.exportClause || ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some(entry => hookMethods.has((entry.propertyName ?? entry.name).text)))) hook(node, 'module hook re-export');
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const target = capability(node);
      if (target && /^module\.(?:registerHooks|register|_resolveFilename|_load|<computed>)$/u.test(target)) hook(node, target);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const target = capability(node.name);
      if (target && /^module\.(?:registerHooks|register|_resolveFilename|_load)$/u.test(target)) hook(node, target);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let target = capability(node.expression), args = [...node.arguments ?? []];
      if (target && /^module\.(?:registerHooks|register|_resolveFilename|_load)$/u.test(target)) hook(node, target);
      if (ts.isCallExpression(node) && ['call', 'apply'].includes(member(node.expression) ?? '')) {
        target = capability(receiver(node.expression));
        args = member(node.expression) === 'apply' && args[1] && ts.isArrayLiteralExpression(unwrap(args[1])) ?
          [...(unwrap(args[1]) as ts.ArrayLiteralExpression).elements] : args.slice(1);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        ['Object', 'Reflect'].includes(node.expression.expression.text) &&
        ['defineProperty', 'defineProperties', 'assign', 'set'].includes(node.expression.name.text) && capability(node.arguments[0]) === 'module') {
        const key = literal(node.arguments[1]);
        if (!key || hookMethods.has(key)) hook(node, 'module hook mutation');
      }
      const method = target?.startsWith('child_process.') ? target.slice('child_process.'.length) : undefined;
      if (method && processMethods.has(method) || target === 'worker_threads.Worker' || target === 'cluster.fork' ||
        target?.startsWith('helper.') && (capability(args[0]) === 'process.execPath' || /(?:^|\/)node(?:\s|$)/u.test(literal(args[0]) ?? ''))) {
        const code = printed(node), command = literal(args[0]);
        const nodeChild = method === 'fork' || target === 'worker_threads.Worker' || target === 'cluster.fork' ||
          capability(args[0]) === 'process.execPath' || /(?:^|[\s/])node(?:\s|$)/u.test(command ?? '');
        launches.push({owner: owner(node), api: target!, code, hash: digest(code), node: nodeChild,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, syntax: node});
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {hooks: [...hooks], launches, source};
}

async function sources(root: string, helper = false): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', ...(helper ? ['dist', 'scripts', 'test', '__tests__'] : [])].includes(entry.name)) result.push(...await sources(path, helper));
    } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) && !/\.d\.[cm]?ts$/u.test(entry.name)) result.push(path);
    else if (entry.name.endsWith('.node')) assert.fail(`Native dependency requires runtime hook/process review: ${path}`);
    else if (entry.isSymbolicLink()) assert.fail(`Uninventoried source alias: ${path}`);
  }
  return result.sort();
}

function embeddedPrograms(source: ts.SourceFile): {name: string; text: string}[] {
  const programs: {name: string; text: string}[] = [];
  const visit = (node: ts.Node): void => {
    const text = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ?
      node.head.text + node.templateSpans.map(span => `undefined${span.literal.text}`).join('') : undefined;
    if (text && /(?:from\s*|require\s*\(\s*)['"](?:node:)?(?:child_process|worker_threads|module)['"]/u.test(text)) {
      const parent = node.parent;
      const name = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : String(node.getStart(source));
      programs.push({name, text});
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return programs;
}

// Exact call pins prevent a reviewed external utility/tool site from becoming
// an unguarded helper Node child. Each allowance documents what executes.
const reviewedLaunches: Record<string, string> = {
  'config.ts#dispatchHelperCommand:child_process.execFile:8ad2d86e241775b095ee9d38cb896b670af15fecf18ec9ed8d92322b39242856': 'Closed helper utility vectors; the separately pinned pre-dispatch guard refuses Node in fixed mode.',
  'linux-proc.ts#verifyLinuxProcExecutable:child_process.spawn:02054a7da26f7f9e6d54793957c13b4936d70a39449307b1833fde27654aa8dc': 'Copied-Node QA observer; fixed mode refuses before temporary files or launch.',
  'runner/linux-containment.ts#spawn:child_process.spawn:4bc707589a62700e016c3a879039b1c172e279fb456447d4950a15e5360f8170': 'Fixed Python containment guardian with closed argv and empty environment; tool execution is a separate admitted workload.',
  'runner/process.ts#<top>:child_process.execFileSync:bd4edd6236e4e2b2cc149833ab5f2c04cba1cb4cdb77416a9dafe1ce7fb4af8d': 'Fixed /bin/ps identity inspection, not a Node child.',
  'runner/process.ts#fencePids:child_process.execFile:d8ba780546a56a95a609cc367a3d08a820d71cafd0e0f5e95e66cabd3002a8b9': 'Fixed /bin/ps Darwin fence inspection.',
  'runner/process.ts#inspectStartIdentity:child_process.execFile:74eab5ae8d3469ac8b34975f5648b4a54ed9b5a60bbb7bf1920f7f27be857cd9': 'Fixed /bin/ps Darwin start identity inspection.',
  'runner/process.ts#processTable:child_process.execFile:680cb9fa150e60475f83ca2748f7c939cdd8b6859b3ed97d113242f668b14097': 'Fixed /bin/ps Darwin process table inspection.',
  'runner/process.ts#sessionGuardian#<top>:child_process.execFileSync:f8489bdf94a6b66a74562c153ee8d0e977abca5481f5d338a46410c9bb7f74bb': 'Embedded Darwin guardian uses only fixed /bin/ps for group inspection.',
  'runner/process.ts#sessionGuardian#<top>:child_process.spawn:f7d729e66d1b1d5e85f0f5d0cb1fbca8d0bfdb224d52eba2862d1d4600eb32bc': 'Embedded Darwin guardian starts the admitted external tool; the guardian itself is unreachable on Linux.',
  'runner/process.ts#startPreparedTool:child_process.spawn:9166ab23f312ba38cd0c57fae5a0d9b9a46cbf6aec2b84db68b1aa4ec0b954d5': 'External tool launch only in the non-Linux branch; Linux requires the containment lifecycle.',
  'runner/process.ts#startPreparedTool:child_process.spawn:d42d58b9894c40ddf1d0ba5473d5519e99c528b196223184f3bbef6c1cb6ca64': 'Helper-owned Node session guardian only in the proven non-Linux branch.',
  'tool-command.ts#runToolCommand:child_process.execFile:581c9f62687de1c8856b18b64a9e5f74c7ee999b9d2839cc662a31d5b61d379e': 'Admitted external tool commands on non-Linux; Linux delegates to contained lifecycle.',
  'updater.ts#signedLatest:helper.runCommand:de2be0fb3f1bd2fc2ea79d7e773eefe48c4e050df4996868a9dfd35da1298b3e': 'Release-verifier Node child; fixed mode refuses at entry and the utility dispatch also refuses.',
  'updater.ts#validateConnection:helper.runPackageCommand:70835421004ad491a4735406cf9e24b701c40970581effb95250f4099f196862': 'Candidate-helper CLI child; fixed mode refuses at entry before invoking the tool runner.',
  'write-lock.ts#linuxFlock:child_process.spawn:7a6771bf370e94b271a65413d55f64589604e6247df2652679bb22c6935761d2': 'Fixed /usr/bin/flock with empty environment and the one explicitly inherited retained FD.',
};

const guardPins = [
  {file: 'config.ts', owner: 'dispatchHelperCommand', indexes: [2], hash: '5aa4cb8eb9169716c0491c085998e717ff49a1291b655f53d0fd1d20722d3d1f'},
  {file: 'linux-proc.ts', owner: 'verifyLinuxProcExecutable', indexes: [0, 1], hash: '072a20568257d210b554206fbb33714369d278015b17bd52bf431089baab1ace'},
  {file: 'updater.ts', owner: 'signedLatest', indexes: [0], hash: '2891f90ebb939ef7273be18cfa09e2462a02dd0adabbb264cad868a3fb53c006'},
  {file: 'updater.ts', owner: 'validateInstalled', indexes: [0], hash: '57e059db55bb5839da64cc0c4a850b273ca06a669910ef79c8757139b2508e41'},
  {file: 'updater.ts', owner: 'validateConnection', indexes: [0], hash: '3cbfc1e84c5d9c5e57e0628fbc3388377089eef259cfce180ba2a9ae18725951'},
];
function guardViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return guardPins.filter(pin => pin.file === file).flatMap(pin => {
    const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === pin.owner);
    const statements = pin.indexes.map(index => fn?.body?.statements[index]);
    return statements.every(Boolean) && digest(statements.map(node => printed(node!)).join('\n')) === pin.hash ? [] :
      [`${file}#${pin.owner}: fixed-mode refusal must remain at its reviewed pre-launch position`];
  });
}

function darwinGuardianOnly(audit: Audit): boolean {
  const fn = audit.source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'startPreparedTool');
  if (!fn?.body || !fn.body.statements.some(statement => printed(statement) === "const linux = process.platform === 'linux';")) return false;
  return audit.launches.filter(launch => launch.owner === 'startPreparedTool').every(launch => {
    for (let node: ts.Node | undefined = launch.syntax; node && node !== fn; node = node.parent) {
      if (ts.isIfStatement(node) && printed(node.expression) === 'linux' && node.elseStatement &&
        launch.syntax.pos >= node.elseStatement.pos && launch.syntax.end <= node.elseStatement.end) return true;
    }
    return false;
  });
}

test('S5-07: helper process creation stays inside the reviewed launch inventory', async () => {
  const inventory: string[] = [];
  for (const path of await sources(sourceRoot, true)) {
    const file = normalize(relative(sourceRoot, path));
    const text = await readFile(path, 'utf8'), found = runtimeAudit(file, text);
    assert.deepEqual(guardViolations(file, text), [], file);
    if (file === 'runner/process.ts') assert.ok(darwinGuardianOnly(found), 'a helper Node guardian must never launch in fixed Linux mode');
    for (const launch of found.launches) inventory.push(`${file}#${launch.owner}:${launch.api}:${launch.hash}`);
    for (const program of embeddedPrograms(found.source)) {
      const embedded = runtimeAudit(`${file}.${program.name}.ts`, program.text);
      assert.deepEqual(embedded.hooks, [], `${file}#${program.name}: embedded loader hook`);
      for (const launch of embedded.launches) inventory.push(`${file}#${program.name}#${launch.owner}:${launch.api}:${launch.hash}`);
    }
  }
  assert.ok(Object.values(reviewedLaunches).every(reason => reason.length > 25), 'every launch allowance requires a concrete reason');
  assert.deepEqual(inventory.sort(), Object.keys(reviewedLaunches).sort(), 'new or changed launch sites require review and a guard-first or fixed-mode refusal proof');
});

test('S5-07: removing, weakening or delaying child refusals fails the static review', async () => {
  for (const file of [...new Set(guardPins.map(pin => pin.file))]) {
    const text = await readFile(join(sourceRoot, file), 'utf8');
    assert.deepEqual(guardViolations(file, text), [], file);
    const weakened = file === 'updater.ts' ? text.replaceAll('assertSystemRuntimeOperation(options.bundledRoot,', 'assertSystemRuntimeOperation(otherRoot,') :
      text.replaceAll('systemRuntimeMode(', 'ignoredSystemRuntimeMode(');
    assert.ok(guardViolations(file, weakened).length, `${file}: weakened guard`);
    for (const pin of guardPins.filter(pin => pin.file === file)) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === pin.owner)!;
      const statement = fn.body!.statements[pin.indexes[0]];
      const delayed = text.slice(0, statement.getStart(source)) + text.slice(statement.end, fn.body!.end - 1) +
        statement.getText(source) + text.slice(fn.body!.end - 1);
      assert.ok(guardViolations(file, delayed).length, `${file}#${pin.owner}: delayed guard`);
    }
  }
  const guardian = await readFile(join(sourceRoot, 'runner/process.ts'), 'utf8');
  assert.equal(darwinGuardianOnly(runtimeAudit('runner/process.ts', guardian.replace("const linux = process.platform === 'linux';", 'const linux = options.platform;'))), false);
});

type Manifest = {name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, {optional?: boolean}>};
type Lock = {packages: Record<string, Manifest & {dev?: boolean}>};
async function dependencyClosure(root: string, entry: Manifest) {
  const packages = new Map<string, {root: string; manifest: Manifest}>(), omitted = new Set<string>();
  const queue = [{root, manifest: entry}];
  while (queue.length) {
    const parent = queue.shift()!;
    const require = createRequire(join(parent.root, 'package.json'));
    for (const name of Object.keys({...parent.manifest.dependencies, ...parent.manifest.optionalDependencies, ...parent.manifest.peerDependencies}).sort()) {
      let location: string;
      try {
        try {location = require.resolve(name + '/package.json');} catch {location = require.resolve(name);}
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' &&
          (Object.hasOwn(parent.manifest.optionalDependencies ?? {}, name) || parent.manifest.peerDependenciesMeta?.[name]?.optional)) {
          omitted.add(`${parent.manifest.name}@${parent.manifest.version}:${name}`); continue;
        }
        throw error;
      }
      let directory = dirname(location), manifest: Manifest | undefined;
      while (dirname(directory) !== directory) {
        try {
          const candidate: Manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          if (candidate.name === name) {manifest = candidate; break;}
        } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
        directory = dirname(directory);
      }
      assert.ok(manifest, `${name}: package manifest was not found`);
      const canonical = await realpath(directory);
      if (!packages.has(canonical)) {
        const child = {root: canonical, manifest}; packages.set(canonical, child); queue.push(child);
      }
    }
  }
  return {packages: [...packages.values()], omitted: [...omitted].sort()};
}

test('S5-07: loader-hook audit resolves module aliases and override syntax', () => {
  for (const source of [
    `module.registerHooks({resolve() {}});`,
    `module.register('./loader.js');`,
    `Module._resolveFilename = replacement;`,
    `module.constructor._load = replacement;`,
    `Object.defineProperty(module.constructor, '_load', {value: replacement});`,
    `import {registerHooks as install} from 'node:module'; install({});`,
    `import {register as install} from 'module'; install('./loader.js');`,
    `import * as loader from 'node:module'; const install = loader.registerHooks; install({});`,
    `import Module from 'module'; Module._resolveFilename = replacement;`,
    `import {Module as Loader} from 'node:module'; Object.defineProperty(Loader, '_load', {value: replacement});`,
    `const loader = require('node:' + 'module'); const key = 'register' + 'Hooks'; loader[key]({});`,
    `const {registerHooks: install} = await import('node:module'); install({});`,
    `const {Module: Loader} = require('module'); const alias = Loader; alias['_load'] = replacement;`,
    `const loader = process.getBuiltinModule('module'); Reflect.set(loader, '_resolveFilename', replacement);`,
    `import {createRequire as acquire} from 'node:module'; const load = acquire(import.meta.url); load('module').register('./loader.js');`,
    `import Module from 'node:module'; Reflect.get(Module, 'registerHooks')({});`,
    `import Module from 'node:module'; const key = choose(); Module[key]({});`,
    `import Module from 'node:module'; Object.assign(Module, {_load: replacement});`,
    `export {registerHooks as install} from 'node:module';`,
  ]) assert.ok(runtimeAudit('new-runtime.ts', source).hooks.length, source);
  for (const source of [
    `import {createHash} from 'node:crypto'; createHash('sha256');`,
    `import Module from 'node:module'; { const Module = application; Module.register(); }`,
    `const registry = {register() {}}; registry.register();`,
    `import type {RegisterHooks} from 'node:module';`,
  ]) assert.deepEqual(runtimeAudit('plain.ts', source).hooks, [], source);
});

test('S5-07: process inventory resolves imported, dynamic, destructured and bound aliases', () => {
  for (const source of [
    `import {Worker as Launch} from 'node:worker_threads'; new Launch('code', {eval: true});`,
    `const {Worker: Launch} = await import('worker_threads'); new Launch('./worker.js');`,
    `import {spawn as launch} from 'node:child_process'; const alias = launch; alias(process.execPath, ['entry.js']);`,
    `const child = require('child_process'); child['spawn']('node', ['entry.js']);`,
    `import * as child from 'node:child_process'; const {fork: launch} = child; launch('./entry.js');`,
    `import {spawn} from 'node:child_process'; spawn.call(null, process.execPath, ['entry.js']);`,
    `import {fork} from 'node:child_process'; const launch = fork.bind(null); launch('./entry.js');`,
    `import {execFile} from 'node:child_process'; const launch = promisify(execFile); launch(process.execPath, ['entry.js']);`,
    `import {runCommand as launch} from '../config.js'; launch(process.execPath, ['entry.js']);`,
  ]) assert.ok(runtimeAudit('new-runtime.ts', source).launches.some(launch => launch.node), source);
  assert.deepEqual(runtimeAudit('plain.ts', `import {spawn} from 'node:child_process'; {const spawn = callback; spawn();}`).launches, []);
});

test('S5-07: production loader hooks exist only in the preflight module', async () => {
  const paths = await sources(sourceRoot, true);
  if (sourceRoot === packageRoot.replace(/\/$/u, '')) paths.push(...await sources(sharedRoot, true));
  const hooks: string[] = [];
  for (const path of paths) {
    const file = normalize(relative(sourceRoot, path)), found = runtimeAudit(file, await readFile(path, 'utf8'));
    if (file === 'system-runtime-preflight.ts') {
      assert.ok(found.hooks.length > 0, 'the inventoried preflight guard must still install its hooks');
      // The exact preflight guard body is independently pinned by the process
      // and filesystem source guards. This exemption is root-relative only.
    } else hooks.push(...found.hooks.map(finding => `${file}:${finding}`));
  }
  assert.deepEqual(hooks, [], 'an additional loader hook would weaken the fixed installation resolution guard');
});

test('S5-07: all installed locked runtime dependencies are audited for hooks and process creation', async t => {
  const lock: Lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  const entry = lock.packages[''];
  assert.ok(entry?.dependencies && Object.keys(entry.dependencies).length, 'runtime dependency roots must not disappear from the audit');
  const closure = await dependencyClosure(packageRoot, entry);
  const expected = [...new Set(Object.entries(lock.packages).filter(([path, item]) => path && !item.dev)
    .map(([path, item]) => `${path.split('node_modules/').at(-1)}@${item.version}`))].sort();
  const actual = [...new Set(closure.packages.map(item => `${item.manifest.name}@${item.manifest.version}`))].sort();
  // Synthetic export fixtures deliberately omit transitive lock entries. They
  // still scan the installed manifest closure; real release locks must cover
  // the entire installed runtime graph, not only direct dependencies.
  if (expected.length) assert.deepEqual(actual, expected, 'installed runtime packages must match the complete locked closure');
  else t.diagnostic('Synthetic lock has no transitive entries; auditing the installed runtime manifest closure.');
  const hooks: string[] = [], processes: string[] = [];
  let files = 0;
  for (const item of closure.packages) for (const path of await sources(item.root)) {
    assert.ok((await lstat(path)).isFile());
    const file = `${item.manifest.name}@${item.manifest.version}/${normalize(relative(item.root, path))}`;
    const found = runtimeAudit(file, await readFile(path, 'utf8')); files++;
    hooks.push(...found.hooks.map(finding => `${file}:${finding}`));
    processes.push(...found.launches.map(launch => `${file}#${launch.owner}:${launch.api}:${launch.hash}`));
    for (const program of embeddedPrograms(found.source)) {
      const embedded = runtimeAudit(`${file}.${program.name}.ts`, program.text);
      hooks.push(...embedded.hooks.map(finding => `${file}#${program.name}:${finding}`));
      processes.push(...embedded.launches.map(launch => `${file}#${program.name}#${launch.owner}:${launch.api}:${launch.hash}`));
    }
  }
  assert.deepEqual(hooks, [], 'no runtime dependency currently requires a loader-hook allowance');
  // Dependency-created workers do not inherit the helper-owned child promise.
  // There are currently none, and any future process capability needs an
  // explicit, justified inventory update rather than silently escaping review.
  assert.deepEqual(processes, [], 'runtime dependency process-creation inventory changed');
  t.diagnostic(`Audited ${actual.length} runtime package versions and ${files} executable source files; omitted optional dependencies: ${closure.omitted.join(', ') || 'none'}.`);
});

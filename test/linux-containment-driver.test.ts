import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {qualifierSourceOnlySkip} from './support/qualifier-source-layout.js';

const installed = '/usr/local/libexec/mdai/native-s3/helper/scripts/run-linux-containment-native.mjs';
const controller = '0::/system.slice/mdai-helper.service/controller';
const control = '0::/system.slice/mdai-helper.service/.control';

/** Evaluate the complete real driver with module and OS seams, retaining every
 * guard and await. Imports remain in-process and no service or process is run. */
async function driver(options: {
  args?: string[]; modulePath?: string; executable?: string; username?: string; uid?: number;
  sourceUid?: number; sourceMode?: number; membership?: string; afterMove?: string; failImport?: number;
  probeRegistration?: boolean;
} = {}) {
  const source = await readFile(new URL('../scripts/run-linux-containment-native.mjs', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('native-driver.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports: string[] = [], writes: {path: string; data: string}[] = [], lifetime: string[] = [], recovery: string[] = [], events: string[] = [];
  let activeImports = 0, maxActiveImports = 0, membershipReads = 0;
  const beforeHooks: (() => Promise<void>)[] = [], importedPlatforms: string[] = [], testBodies: string[] = [];
  let releaseBody!: () => void, body: Promise<void> | undefined;
  const heldBody = new Promise<void>(resolve => {releaseBody = resolve;});
  const env: Record<string, string> = new Proxy({}, {set(target: Record<string, string>, name: string, value: string) {
    events.push(`enable:${name}`); target[name] = value; return true;
  }});
  const fixtureProcess = {argv: ['/usr/local/libexec/mdai/node', installed, ...(options.args ?? [])],
    execPath: '/usr/local/libexec/mdai/node', getuid: () => options.uid ?? 999, env, platform: 'linux'};
  const modules = {
    'node:assert/strict': {default: assert},
    'node:process': {default: fixtureProcess},
    'node:test': {before: (hook: () => Promise<void>) => {beforeHooks.push(hook);}},
    'node:fs/promises': {
      async lstat(path: string) {
        assert.equal(path, installed);
        return {uid: options.sourceUid ?? 0, mode: options.sourceMode ?? 0o100755};
      },
      async realpath(path: string) {
        assert.equal(path, '/usr/local/libexec/mdai/node');
        return options.executable ?? path;
      },
      async readFile(path: string, encoding: string) {
        assert.equal(path, '/proc/self/cgroup'); assert.equal(encoding, 'utf8');
        events.push('membership');
        return (membershipReads++ === 0 ? options.membership ?? control : options.afterMove ?? controller) + '\n';
      },
      async writeFile(path: string, data: string) {events.push('move'); writes.push({path, data});},
    },
    'node:os': {userInfo: () => ({username: options.username ?? 'mdai'})},
    'node:url': {fileURLToPath},
  };
  const transformed = ts.transform(tree, [context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isImportDeclaration(node)) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier));
        assert.ok(Object.hasOwn(modules, node.moduleSpecifier.text), `unreviewed driver import: ${node.moduleSpecifier.text}`);
        const clause = node.importClause;
        assert.ok(clause);
        const module = () => ts.factory.createElementAccessExpression(ts.factory.createIdentifier('fixtureModules'), node.moduleSpecifier as ts.StringLiteral);
        const declarations: ts.VariableDeclaration[] = [];
        if (clause.name) declarations.push(ts.factory.createVariableDeclaration(clause.name, undefined, undefined,
          ts.factory.createPropertyAccessExpression(module(), 'default')));
        if (clause.namedBindings) {
          assert.ok(ts.isNamedImports(clause.namedBindings));
          const bindings = ts.factory.createObjectBindingPattern(clause.namedBindings.elements.map(element =>
            ts.factory.createBindingElement(undefined, element.propertyName, element.name)));
          declarations.push(ts.factory.createVariableDeclaration(bindings, undefined, undefined, module()));
        }
        return ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList(declarations, ts.NodeFlags.Const));
      }
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return ts.factory.createIdentifier('fixtureMeta');
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.updateCallExpression(node, ts.factory.createIdentifier('fixtureImport'), undefined,
          ts.visitNodes(node.arguments, visit) as ts.NodeArray<ts.Expression>);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  try {
    const driverBody = ts.createPrinter().printList(ts.ListFormat.MultiLine, transformed.transformed[0].statements, tree);
    const result = runInNewContext(`(async () => {\n${driverBody}\n})()`, {
      fixtureModules: modules, fixtureMeta: {url: pathToFileURL(options.modulePath ?? installed).href},
      async fixtureImport(specifier: string) {
        events.push(`import:${specifier}`); imports.push(specifier);
        importedPlatforms.push(fixtureProcess.platform);
        if (options.probeRegistration && imports.length === 1) {
          // node:test starts queued bodies while a later dynamic import awaits.
          // Model that scheduling below the driver's real registration barrier.
          body = Promise.all(beforeHooks.map(hook => hook())).then(async () => {
            fixtureProcess.platform = 'darwin'; testBodies.push('platform fixture');
            try {await heldBody;} finally {fixtureProcess.platform = 'linux';}
          });
        }
        activeImports++; maxActiveImports = Math.max(maxActiveImports, activeImports);
        await Promise.resolve();
        activeImports--;
        if (imports.length === options.failImport) throw new Error('fixture module unavailable');
        return {async runServiceLifetimeFixture(mode: string) {lifetime.push(mode);},
          async runLinuxWriteLockRecoveryFixture(mode: string) {recovery.push(mode);}};
      },
    }, {timeout: 1000}) as Promise<void>;
    return {result, imports, writes, lifetime, recovery, events, env, importedPlatforms, testBodies, releaseBody,
      get body() {return body;}, get maxActiveImports() {return maxActiveImports;}};
  } finally {transformed.dispose();}
}

test('native driver imports every service-gated TS suite sequentially after verifying its controller membership', {skip: qualifierSourceOnlySkip}, async () => {
  const f = await driver();
  await f.result;
  assert.deepEqual(f.writes, [{path: '/sys/fs/cgroup/system.slice/mdai-helper.service/controller/cgroup.procs', data: '0\n'}]);
  assert.deepEqual(f.events.slice(0, 5), ['membership', 'move', 'membership',
    'enable:MDAI_LINUX_NATIVE_CONTAINMENT', 'enable:MDAI_LINUX_NATIVE_TESTS']);
  assert.deepEqual(f.env, {MDAI_LINUX_NATIVE_CONTAINMENT: '1', MDAI_LINUX_NATIVE_TESTS: '1'});
  assert.equal(f.maxActiveImports, 1, 'all native test registrations share the verified process and finish importing in order');
  assert.equal(f.lifetime.length, 0);
  assert.ok(f.imports.length > 0);
  const suites = f.imports.map(specifier => {
    assert.match(specifier, /^\.\.\/test\/[a-z][a-z0-9-]*\.test\.js$/u);
    return specifier.slice('../test/'.length, -'.test.js'.length);
  });
  assert.deepEqual(suites, [...new Set(suites)].sort(), 'the native suite inventory is unique and deterministic');
  for (const name of await readdir(new URL('./', import.meta.url))) {
    if (!name.endsWith('.test.ts')) continue;
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    let gated = false;
    const visit = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'linuxNativeWorkloadSkip') gated = true;
      if (ts.isPropertyAccessExpression(node) && node.name.text.startsWith('MDAI_LINUX_NATIVE_') &&
          ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'env' &&
          ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process') gated = true;
      ts.forEachChild(node, visit);
    };
    visit(tree);
    if (gated) assert.ok(suites.includes(name.slice(0, -'.test.ts'.length)), `${name}: gated tests are unreachable from the installed native driver`);
  }
});

test('native driver evaluates every suite gate before a queued platform fixture may run', {skip: qualifierSourceOnlySkip}, async t => {
  const f = await driver({probeRegistration: true});
  t.after(() => f.releaseBody());
  await f.result;
  assert.equal(f.imports.length, 12);
  assert.deepEqual(f.importedPlatforms, Array(12).fill('linux'), 'later native gates must see the real platform');
  f.releaseBody(); await f.body;
  assert.deepEqual(f.testBodies, ['platform fixture'], 'registration must release the normal sequential tests');
});

test('native driver never releases queued bodies after a compiled suite import fails', {skip: qualifierSourceOnlySkip}, async t => {
  const f = await driver({probeRegistration: true, failImport: 2});
  t.after(() => f.releaseBody());
  await assert.rejects(f.result, /fixture module unavailable/u);
  await Promise.resolve();
  assert.deepEqual(f.testBodies, []);
  assert.deepEqual(f.importedPlatforms, ['linux', 'linux']);
});

test('native driver rejects invalid invocation, identity, installation and cgroup before enabling suites', {skip: qualifierSourceOnlySkip}, async t => {
  const invalid: {name: string; options: Parameters<typeof driver>[0]}[] = [
    {name: 'unknown mode', options: {args: ['--unknown']}},
    {name: 'extra argument', options: {args: ['--suites', 'extra']}},
    {name: 'different installation', options: {modulePath: installed.replace('/native-s3/', '/native-s5/')}},
    {name: 'different private Node', options: {executable: '/usr/bin/node'}},
    {name: 'different account name', options: {username: 'other'}},
    {name: 'different account ID', options: {uid: 1000}},
    {name: 'non-root fixture owner', options: {sourceUid: 999}},
    {name: 'group-writable fixture', options: {sourceMode: 0o100775}},
    {name: 'world-writable fixture', options: {sourceMode: 0o100757}},
    ...['0::/', `${controller}-other`, `${controller}/child`, '0::/system.slice/other.service/.control'].map(membership =>
      ({name: `outside dedicated service: ${membership}`, options: {membership}})),
  ];
  for (const {name, options} of invalid) await t.test(name, async () => {
    const f = await driver(options);
    await assert.rejects(f.result);
    assert.deepEqual(f.writes, [], 'refuse before moving any process');
    assert.deepEqual(f.env, {}); assert.deepEqual(f.imports, []); assert.deepEqual(f.lifetime, []);
  });
  const f = await driver({afterMove: control});
  await assert.rejects(f.result);
  assert.equal(f.writes.length, 1, 'a failed controller move is independently checked');
  assert.deepEqual(f.env, {}); assert.deepEqual(f.imports, []);
});

test('native driver preserves explicit suite and service-lifetime routing without swallowing missing compiled modules', {skip: qualifierSourceOnlySkip}, async () => {
  const defaults = await driver({membership: controller});
  await defaults.result;
  const suites = await driver({args: ['--suites']});
  await suites.result;
  assert.deepEqual(suites.imports, defaults.imports);
  const missing = await driver({failImport: 2});
  await assert.rejects(missing.result, /fixture module unavailable/u);
  assert.deepEqual(missing.imports, defaults.imports.slice(0, 2));
  for (const mode of ['hold', 'verify']) {
    const f = await driver({args: [`--service-lifetime-${mode}`]});
    await f.result;
    assert.deepEqual(f.imports, ['../test/fixtures/linux-service-lifetime.js']);
    assert.deepEqual(f.lifetime, [mode]);
  }
});

test('S5-10 recovery phases stay outside helper units without moving a process or enabling native workloads', {skip: qualifierSourceOnlySkip}, async () => {
  for (const mode of ['prepare', 'seal', 'verify']) {
    const f = await driver({args: [`--write-lock-recovery-${mode}`], membership: '0::/user.slice/user-999.slice/session-42.scope'});
    await f.result;
    assert.deepEqual(f.imports, ['../test/fixtures/linux-write-lock-recovery.js']);
    assert.deepEqual(f.recovery, [mode]);
    assert.deepEqual(f.writes, [], 'recovery never migrates itself into the controller leaf');
    assert.deepEqual(f.env, {}, 'recovery never enables a workload suite');
    assert.deepEqual(f.lifetime, []);
  }
});

test('S5-10 rejects active helper membership and installation faults before importing recovery', {skip: qualifierSourceOnlySkip}, async () => {
  for (const membership of [controller, control, `${controller}/child`, '0::/user.slice/app.maddots.ai.helper.service']) {
    const f = await driver({args: ['--write-lock-recovery-seal'], membership});
    await assert.rejects(f.result, /outside the stopped and disabled helper units/u);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.env, {}); assert.deepEqual(f.imports, []);
  }
  for (const options of [{uid: 0}, {username: 'sd'}, {sourceUid: 999}, {sourceMode: 0o100775}, {executable: '/usr/bin/node'}]) {
    const f = await driver({...options, args: ['--write-lock-recovery-prepare'], membership: '0::/'});
    await assert.rejects(f.result);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.imports, []);
  }
  const missing = await driver({args: ['--write-lock-recovery-verify'], membership: '0::/', failImport: 1});
  await assert.rejects(missing.result, /fixture module unavailable/u);
  assert.deepEqual(missing.recovery, []);
});

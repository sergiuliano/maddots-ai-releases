import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join, posix, relative} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../src/config.ts', import.meta.url));
const sharedRoot = fileURLToPath(new URL('../src/shared/', import.meta.url));
const sourcePrefix = relative(packageRoot, sourceRoot).replace(/config\.ts$/u, '').split('\\').join('/');
// child_process covers exec/execFile/spawn/fork and their synchronous forms;
// cluster can select an executable with setupPrimary/setupMaster before fork;
// worker_threads can execute either a file or an eval worker. module exposes
// alternate native-module loaders. process.execve/dlopen are checked below.
// node:vm stays outside this OS-execution inventory: compiling/running JS in
// this process does not itself spawn, replace, or load a native executable.
const primitiveModules = new Set(['child_process', 'cluster', 'worker_threads', 'module']);
const nativeProcessApis = new Set(['binding', '_linkedBinding', 'dlopen', 'execve', 'getBuiltinModule', 'mainModule']);
const privilegedExports: Record<string, readonly string[]> = {
  'config.ts': ['runCommand', 'createRuntimeRunner', 'createSecretServiceRunner'],
  'secret-store.ts': ['SecretServiceSecretStore', 'selectSecretStore'],
  'tool-command.ts': ['withClaimedToolCommands', 'currentClaimedToolOperation'],
  'runner/process.ts': ['startTool'],
  'runner/linux-containment.ts': ['containmentBackendForNamespace', 'createLinuxContainmentBackend'],
  'runner/linux-lifecycle.ts': ['runLinuxToolCommand', 'createLinuxToolLifecycle', 'currentLinuxToolLifecycle', 'withLinuxRunContext', 'withLinuxOwnerContext'],
  // Controller preflight owns credential read/refresh authority. Containment
  // receives only the retained prepared lease and cleanup capability.
  'runner/linux-selected-login.ts': ['LinuxSelectedLogin', 'completeSelectedLogin'],
  'runner/linux-login-provider.ts': ['prepareProviderLogin'],
  // Immutable byte preparation precedes authorization. Only the retained
  // workload lifecycle/containment may revalidate the issued provider lease.
  'runner/linux-local-provider.ts': ['prepareLinuxLocalProvider', 'preparedLinuxLocalProvider', 'revalidateLinuxLocalProvider'],
};
// Only these runtime modules may acquire process primitives. There are no
// cluster, Worker, createRequire, execve, binding, or native-addon exceptions.
// Types confer no access. Offline scripts have no runtime allowance.
// The separate fixed-runtime guard can only acquire this exact resolution API
// import. Its runtime uses stay inside the independently pinned guard body.
const resolutionGuard = {
  file: 'system-runtime-preflight.ts', owner: 'installSystemResolutionGuard', hash: 'a448525b11238cea9a31adeb2b8b5929d7d0c42280039b9330a054576385ee3b',
  import: "import { Module as NodeModule, isBuiltin, registerHooks } from 'node:module';",
  bindings: 'Module as NodeModule,isBuiltin,registerHooks',
  reason: 'Constrain fixed-runtime resolution to inventoried installation paths, including Node 22 require.resolve.',
};
const resolutionGuardNames = new Set(['NodeModule', 'registerHooks', '_resolveLookupPaths', '_resolveFilename']);
const primitiveImports: Record<string, string> = {
  'config.ts': 'execFile',
  'tool-command.ts': 'execFile',
  'linux-proc.ts': 'spawn',
  'write-lock.ts': 'spawn',
  'runner/process.ts': 'execFile,execFileSync,spawn',
  'runner/linux-containment.ts': 'spawn',
};
const callers: Record<string, readonly string[]> = {
  'config.ts#runCommand': ['cli-main.ts', 'detect.ts', 'notify.ts', 'process-image.ts', 'provider-keys.ts', 'secret-store.ts', 'service.ts', 'updater.ts', 'write-lock-retirement.ts', 'runner/agents-local.ts'],
  'config.ts#createRuntimeRunner': ['cli-main.ts'],
  'config.ts#createSecretServiceRunner': ['secret-store.ts'],
  'secret-store.ts#SecretServiceSecretStore': ['cli-main.ts'],
  'secret-store.ts#selectSecretStore': ['cli-main.ts'],
  'tool-command.ts#withClaimedToolCommands': ['runner/process.ts'],
  // Job4 passes the already authenticated claim to the contained utility's
  // fresh journal/revalidation. Only that lifecycle may obtain the handle.
  'tool-command.ts#currentClaimedToolOperation': ['runner/linux-lifecycle.ts'],
  'runner/process.ts#startTool': ['runner/runner.ts', 'runner/test-run.ts', 'runner/agents-local.ts'],
  'runner/linux-containment.ts#containmentBackendForNamespace': [],
  'runner/linux-containment.ts#createLinuxContainmentBackend': ['runner/storage-owner.ts'],
  'runner/linux-lifecycle.ts#runLinuxToolCommand': ['tool-command.ts'],
  'runner/linux-lifecycle.ts#createLinuxToolLifecycle': ['runner/runner.ts'],
  'runner/linux-lifecycle.ts#currentLinuxToolLifecycle': ['runner/test-run.ts', 'runner/agents-local.ts'],
  'runner/linux-lifecycle.ts#withLinuxRunContext': ['runner/test-run.ts', 'runner/agents-local.ts'],
  'runner/linux-lifecycle.ts#withLinuxOwnerContext': ['runner/runner.ts'],
  'runner/linux-selected-login.ts#LinuxSelectedLogin': ['runner/linux-lifecycle.ts'],
  'runner/linux-selected-login.ts#completeSelectedLogin': ['runner/linux-containment.ts'],
  'runner/linux-login-provider.ts#prepareProviderLogin': ['runner/linux-selected-login.ts'],
  'runner/linux-local-provider.ts#prepareLinuxLocalProvider': ['runner/runner.ts', 'runner/runs-on.ts'],
  'runner/linux-local-provider.ts#preparedLinuxLocalProvider': ['runner/process.ts'],
  'runner/linux-local-provider.ts#revalidateLinuxLocalProvider': ['runner/linux-lifecycle.ts', 'runner/linux-containment.ts'],
};
// Dynamic imports must name exactly the closed binding in an existing boundary.
const dynamicImports: Record<string, readonly string[]> = {
  'tool-command.ts': ["(await import('./runner/linux-lifecycle.js')).runLinuxToolCommand"],
  'runner/storage-owner.ts': ["{ createLinuxContainmentBackend } = await import('./linux-containment.js')"],
};

type Inventory = {violations: string[]; acquisitions: string[]; exports: string[]; embedded: string[]};
const printer = ts.createPrinter({removeComments: true});
function canonicalSourceFile(path: string, prefix = sourcePrefix): string {
  const file = posix.normalize(path.split('\\').join('/'));
  if (!prefix || file.startsWith('scripts/')) return file;
  return file.startsWith(prefix) ? file.slice(prefix.length) : `<outside-source>/${file}`;
}
function print(node: ts.Node, source: ts.SourceFile): string {return printer.printNode(ts.EmitHint.Unspecified, node, source);}
function reviewedResolutionImport(node: ts.Node): boolean {
  return ts.isImportDeclaration(node) && node.getSourceFile().fileName === resolutionGuard.file &&
    resolutionGuard.reason.length > 0 && print(node, node.getSourceFile()) === resolutionGuard.import;
}
function withinReviewedResolutionGuard(node: ts.Node): boolean {
  if (node.getSourceFile().fileName !== resolutionGuard.file || !resolutionGuard.reason) return false;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === resolutionGuard.owner && ts.isSourceFile(current.parent)) {
      return createHash('sha256').update(print(current, current.getSourceFile())).digest('hex') === resolutionGuard.hash;
    }
  }
  return false;
}
function inType(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) return true;
    if (ts.isStatement(parent) || ts.isFunctionLike(parent) && 'body' in parent && parent.body) return false;
  }
  return false;
}
function literal(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left), right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}
function modulePath(file: string, specifier: string): string {
  return specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.[cm]?js$/u, '.ts') : specifier.replace(/^node:/u, '');
}
function offlineModule(target: string): boolean {
  // The ESM loader decodes URL escapes in relative module specifiers.
  try {return decodeURIComponent(target).split('/').includes('scripts');}
  catch {return true;}
}
function runtimeBindings(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return [];
  if (!clause || clause.name || clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return ['*'];
  return clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.filter(entry => !entry.isTypeOnly)
    .map(entry => entry.propertyName ? `${entry.propertyName.text} as ${entry.name.text}` : entry.name.text).sort() : [];
}

/** Audit capabilities at their acquisition boundary, without attempting to
 * infer which branch, alias, or injected function an arbitrary call will use. */
export function executionInventory(file: string, text: string): Inventory {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[cm]?js$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const inventory: Inventory = {violations: [], acquisitions: [], exports: [], embedded: []};
  const fail = (node: ts.Node, reason: string) => inventory.violations.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${reason}`);
  const importedPrivileged = new Set<string>();
  const processBindings = new Set(['process']);
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
      ['process', 'node:process'].includes(statement.moduleSpecifier.text) && statement.importClause?.name) processBindings.add(statement.importClause.name.text);
  const rawModule = Object.hasOwn(primitiveImports, file) || Object.hasOwn(privilegedExports, file);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = modulePath(file, node.moduleSpecifier.text), bindings = runtimeBindings(node);
      if (/[?#]/u.test(node.moduleSpecifier.text)) fail(node, 'module query or fragment');
      if (bindings.length && offlineModule(target)) fail(node, 'offline script imported by helper runtime');
      if (target === 'process' && bindings.length && (!node.importClause?.name || node.importClause.name.text !== 'process' || node.importClause.namedBindings)) fail(node, 'noncanonical process import');
      if (bindings.length && primitiveModules.has(target)) {
        inventory.acquisitions.push(`${target}:${bindings.join(',')}`);
        if ((target !== 'child_process' || bindings.join(',') !== primitiveImports[file]) && !reviewedResolutionImport(node)) fail(node, `unapproved primitive acquisition ${target}`);
      }
      if (bindings.length && privilegedExports[target]) {
        if (bindings.includes('*')) fail(node, `namespace/default access to ${target}`);
        for (const entry of bindings) {
          const [name, local = name] = entry.split(' as ');
          if (privilegedExports[target].includes(name)) {
            importedPrivileged.add(local);
            if (!(callers[`${target}#${name}`] ?? []).includes(file)) fail(node, `unapproved caller of ${target}#${name}`);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = modulePath(file, node.moduleSpecifier.text);
        if (/[?#]/u.test(node.moduleSpecifier.text)) fail(node, 'module query or fragment');
        if (offlineModule(target)) fail(node, 'offline script re-exported by helper runtime');
        if (primitiveModules.has(target) || target === 'process' || privilegedExports[target]) fail(node, `raw-bearing module re-export ${target}`);
      } else if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.some(entry => !entry.isTypeOnly && importedPrivileged.has((entry.propertyName ?? entry.name).text))) fail(node, 'privileged binding re-export');
    }
    if (rawModule && ts.isExportAssignment(node)) inventory.exports.push(print(node, source));
    else if (rawModule && ts.isExportDeclaration(node) && !node.isTypeOnly) inventory.exports.push(print(node, source));
    else if (rawModule && ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(node)) for (const entry of node.declarationList.declarations) inventory.exports.push(entry.name.getText(source));
      else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) inventory.exports.push(node.name?.text ?? '<default>');
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const value = node.arguments[0] && literal(node.arguments[0]);
      if (value === undefined && !(file === 'runtime.ts' && print(node, source) === "import(pathToFileURL(join(root, 'dist/cli.js')).href)")) fail(node, 'computed module loading');
      else {
        if (value === undefined) {ts.forEachChild(node, visit); return;}
        const target = modulePath(file, value);
        if (/[?#]/u.test(value)) fail(node, 'module query or fragment');
        if (offlineModule(target)) fail(node, 'offline script imported by helper runtime');
        if (primitiveModules.has(target) || target === 'process') fail(node, `dynamic primitive acquisition ${target}`);
        if (privilegedExports[target]) {
          let binding: ts.Node = node;
          while (binding.parent && (ts.isAwaitExpression(binding.parent) || ts.isParenthesizedExpression(binding.parent))) binding = binding.parent;
          if (ts.isPropertyAccessExpression(binding.parent) || ts.isVariableDeclaration(binding.parent)) binding = binding.parent;
          if (!(dynamicImports[file] ?? []).includes(print(binding, source))) fail(node, `dynamic raw-bearing import ${target}`);
        }
      }
    }
    const resolutionImport = reviewedResolutionImport(ts.isIdentifier(node) && ts.isImportSpecifier(node.parent) ?
      node.parent.parent.parent.parent : node);
    if (ts.isIdentifier(node) && resolutionGuardNames.has(node.text) && !inType(node) &&
        !resolutionImport && !withinReviewedResolutionGuard(node)) fail(node, 'resolution guard capability is outside its exact reviewed boundary');
    // require/createRequire and process-native API acquisitions are prohibited,
    // even before a caller aliases or invokes the acquired value.
    if (ts.isIdentifier(node) && ['require', 'createRequire', 'getBuiltinModule', '_linkedBinding', 'dlopen'].includes(node.text) &&
        !ts.isTypeNode(node.parent) && !(ts.isStringLiteralLike(node.parent))) fail(node, `native loader ${node.text}`);
    if (ts.isIdentifier(node) && processBindings.has(node.text) && !ts.isImportClause(node.parent) && !ts.isTypeQueryNode(node.parent)) {
      if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node) fail(node, 'process object alias, destructuring, or computed access');
      else if (nativeProcessApis.has(node.parent.name.text)) fail(node, 'native process API');
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'process' && ['global', 'globalThis'].includes(node.expression.getText(source)) ||
        ts.isElementAccessExpression(node) && ['global', 'globalThis'].includes(node.expression.getText(source))) fail(node, 'indirect global process access');
    if (ts.isElementAccessExpression(node) && node.argumentExpression && nativeProcessApis.has(literal(node.argumentExpression) ?? '')) fail(node, 'computed native loader');
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && ['eval', 'Function', 'Worker'].includes(node.expression.text)) fail(node, 'dynamic executable code');
    if (ts.isStringLiteralLike(node) && (['child_process', 'cluster', 'worker_threads'].includes(node.text.replace(/^node:/u, '')) || ['node:module', 'node:process'].includes(node.text)) &&
        !(ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isLiteralTypeNode(node.parent))) {
      fail(node, `indirect primitive acquisition ${node.text}`);
    }
    // Embedded code is opaque to TypeScript. Pin its entire declaration or
    // assignment, including the binding name and every interpolated expression.
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
        /child_process|worker_threads|node:cluster|\bprocess\.(?:execve|dlopen)\b|\bos\.(?:exec\w*|fork|system|popen)\s*\(|\bsubprocess\.|#!\/bin\/sh|ObjC\.bindFunction|verifyReleaseBundle\} from/u.test(node.getText(source)) &&
        !(ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))) {
      let binding: ts.Node = node;
      while (binding.parent && !ts.isVariableDeclaration(binding) && !ts.isReturnStatement(binding) && !ts.isSourceFile(binding.parent)) binding = binding.parent;
      inventory.embedded.push(createHash('sha256').update(print(binding, source)).digest('hex'));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const key of ['acquisitions', 'exports', 'embedded'] as const) inventory[key].sort();
  return inventory;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (!['test', '__tests__', 'dist', 'node_modules', '.git', 'scripts'].includes(entry.name)) files.push(...await sourceFiles(join(directory, entry.name)));
    } else if (/\.(?:[cm]?[jt]s|[jt]sx|py|sh|bash|c|cc|cpp|rs)$/u.test(entry.name) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(join(directory, entry.name));
  }
  return files;
}

// Fixed inventory, not snapshots regenerated during tests. Changing a privileged
// export or opaque runtime script requires reviewing this boundary.
const reviewedExports: Record<string, readonly string[]> = {
  "config.ts": [
    "CommandError",
    "HelperError",
    "cleanEnvironment",
    "clock",
    "createRuntimeRunner",
    "createSecretServiceRunner",
    "endpointUrl",
    "readConfig",
    "runCommand"
  ],
  "linux-proc.ts": [
    "LinuxProcError",
    "inspectLinuxProcess",
    "inspectLinuxProcessSync",
    "linuxBootId",
    "linuxFenceMatches",
    "linuxFencePids",
    "linuxProcessIdentity",
    "linuxProcessIdentityFrom",
    "linuxProcessTable",
    "parseLinuxProcStat",
    "verifyLinuxProcExecutable"
  ],
  "runner/linux-containment.ts": [
    "LINUX_CONTAINMENT_PATHS",
    "LINUX_PROVIDER_CGROUP_LIMITS",
    "cleanLinuxToolEnvironment",
    "configureLinuxProviderResources",
    "containmentBackendForNamespace",
    "createLinuxContainmentBackend",
    "linuxProviderOomCount",
    "linuxSandboxArguments",
    "qualifyLinuxRuntimeMounts"
  ],
  "runner/linux-lifecycle.ts": [
    "createLinuxToolLifecycle",
    "currentLinuxRunIsRetired",
    "currentLinuxToolLifecycle",
    "runLinuxToolCommand",
    "withLinuxOwnerContext",
    "withLinuxRunContext"
  ],
  "runner/linux-login-provider.ts": [
    "prepareProviderLogin",
    "safeSelectedLoginError",
    "selectedLoginError",
    "selectedLoginFailure"
  ],
  "runner/linux-local-provider.ts": [
    "LINUX_LOCAL_PROVIDER_INVENTORY",
    "LINUX_LOCAL_PROVIDER_MODEL",
    "LINUX_LOCAL_PROVIDER_PREPARE_MS",
    "LINUX_LOCAL_PROVIDER_UPSTREAM",
    "LINUX_LOCAL_PROVIDER_URL",
    "LINUX_LOCAL_PROVIDER_VERSION",
    "assertLinuxLocalProviderSpec",
    "linuxLocalProviderSelection",
    "parseLinuxLocalProviderInventory",
    "prepareLinuxLocalProvider",
    "preparedLinuxLocalProvider",
    "revalidateLinuxLocalProvider"
  ],
  "runner/linux-selected-login.ts": [
    "LinuxSelectedLogin",
    // Pure sanitized publication classification, no credential or execution authority.
    "SelectedLoginScanIncompleteError",
    "completeSelectedLogin"
  ],
  "runner/process.ts": [
    "PROCESS_CLEANUP_CAP_MS",
    "ProcessCleanupError",
    "ProcessRefusal",
    "beforeDeadline",
    "buildToolEnvironment",
    "cleanupRunHome",
    "cleanupRunHomes",
    "computeRunDeadline",
    "enforceAdapter",
    "enforceExecutableAdapter",
    "hasLegacyLinuxIdentity",
    "processIsRunning",
    "processStartIdentity",
    "recoverProcess",
    "requireProcessInspection",
    "startTool",
    "timeoutSeconds",
    "validateQaEnv",
    "verifyLegacyProcessAbsence"
  ],
  "secret-store.ts": [
    "FILE_STORAGE_WARNING",
    "FileSecretStore",
    "KeychainSecretStore",
    "SecretServiceSecretStore",
    "credentialCapabilities",
    "requireCredentialCapability",
    "selectSecretStore"
  ],
  "tool-command.ts": [
    "assertToolCommandAllowed",
    "currentClaimedToolOperation",
    "guardToolRunner",
    "runToolCommand",
    "toolCommandPolicy",
    "withClaimedToolCommands"
  ],
  "write-lock.ts": [
    "acquireDirectoryWriteGuard",
    "acquireWriteGuard",
    "withWriteLock"
  ]
};
const reviewedEmbedded: Record<string, readonly string[]> = {
  "config.ts": [
    "73bec367585491b6cc2ca52c9215ed88793e23462cd5bf0b9a8ad85e26548a7e",
    "7acfba2b50615d9c909f5c773bfc94538a257891ec352f1e40f3290943f8da9a"
  ],
  "notify.ts": [
    "6fac4d247504f842b8f90bb28c0a3d925b203bcb7931ec7f5d310dde775794a1"
  ],
  "process-image.ts": [
    "567d949ed0a8d38f6dd6d6bb4e50d9ce43eb6a7d354b1517a80095e7238414e7"
  ],
  "runner/agents-local.ts": [
    "4160a354dd408c15b720803fa336358a468d20f50b58e7b772b79438f2b2e964"
  ],
  "runner/linux-guardian.ts": [
    // Reviewed kernel-only admission failure and CLOEXEC/task proof. Process acquisitions,
    // exports, the self-group TERM sink and scanner rules are unchanged.
    // S5 inner-created private channel preserves release validation and live-task proof.
    // S5 exec-error classifies only execve OSError; failure teardown and signal scope remain unchanged.
    // Selected Claude reads only its fixed private token inside the existing sandbox before final admission checks.
    // The guardian releases inherited output pipes after spawn via fixed /dev/null descriptors; execution and signal authority are unchanged.
    // Slice6a forks only the sandbox provider/monitor after bound RELEASE. Both exec boundaries
    // recheck expiry/control, the monitor closes proof/output copies, and original-task proof remains authoritative.
    // Fix 3 requires registered-channel acknowledgement before fork, replays prior sealing,
    // and retains a shared unread cancellation socket through both final exec checks.
    // s5.7.2 pins Qwen3 and validates a retained immutable provider cwd descriptor
    // before fchdir and execve; final admission and signal authority are preserved.
    "1fb4b82c39c93811b0e32311c6dab8f16ac5cbbace0738cc9be977c7ae8bb1d5",
    "ca53da66b0949cc65be9e78080a80a2dd3a3cfa027efada6337e5221372aa10e"
  ],
  "runner/process.ts": [
    "50d10bea0a20d0f3b750adecc91768c5e954e5b3304d197a8788044a4dc74ef9"
  ],
  "updater.ts": [
    "9d72d52947a3e8841492639b65343148e2153a9f388fa34328a436b8d26ed6a2"
  ]
};

function violations(file: string, text: string): string[] {
  const found = executionInventory(file, text), failures = [...found.violations];
  if (/\.(?:py|sh|bash|c|cc|cpp|rs)$/u.test(file)) failures.push('unapproved native source');
  const expectedAcquisitions = primitiveImports[file] ? [`child_process:${primitiveImports[file]}`] :
    file === resolutionGuard.file ? [`module:${resolutionGuard.bindings}`] : [];
  if (JSON.stringify(found.acquisitions) !== JSON.stringify(expectedAcquisitions)) failures.push('primitive acquisition inventory changed');
  if (JSON.stringify(found.exports) !== JSON.stringify([...(reviewedExports[file] ?? [])].sort())) failures.push('raw-bearing exports changed');
  if (JSON.stringify(found.embedded) !== JSON.stringify([...(reviewedEmbedded[file] ?? [])].sort())) failures.push('embedded program or its binding changed');
  return failures;
}

test('S4: raw process acquisition and exports stay inside the reviewed module boundaries', async () => {
  for (const path of await sourceFiles(packageRoot)) {
    const file = canonicalSourceFile(relative(packageRoot, path));
    assert.deepEqual(violations(file, await readFile(path, 'utf8')), [], file);
  }
  // Shared runtime dependencies are outside helper/ in a checkout and inside
  // src/shared/ in the public export. Neither layout grants primitive access.
  if (!sourcePrefix) for (const path of await sourceFiles(sharedRoot)) {
    const file = `shared/${relative(sharedRoot, path).split('\\').join('/')}`;
    assert.deepEqual(violations(file, await readFile(path, 'utf8')), [], file);
  }
});

test('S5-07: only the exact fixed-runtime resolution acquisition is admitted', async () => {
  assert.deepEqual(violations(resolutionGuard.file, resolutionGuard.import), []);
  assert.deepEqual(executionInventory(resolutionGuard.file, resolutionGuard.import).acquisitions,
    [`module:${resolutionGuard.bindings}`]);
  for (const file of [resolutionGuard.file, 'config.ts', 'cli.ts', 'ordinary.ts']) for (const source of [
    `import {createRequire} from 'node:module'`,
    `import Module from 'node:module'`, `import * as Module from 'node:module'`,
    `import {default as NodeModule} from 'node:module'`,
    `import {Module as NodeModule, isBuiltin, registerHooks, createRequire} from 'node:module'`,
    `import {Module as OtherModule, isBuiltin, registerHooks} from 'node:module'`,
    `export {Module, registerHooks} from 'node:module'`,
    `const hooks = await import('node:module')`,
    `${resolutionGuard.import} const exposed = NodeModule`,
    `${resolutionGuard.import} const exposed = NodeModule._resolveFilename`,
    `${resolutionGuard.import} registerHooks({resolve(specifier, context, next) {return next(specifier, context)}})`,
    `${resolutionGuard.import} function installSystemResolutionGuard() {return NodeModule._resolveLookupPaths}`,
  ]) assert.ok(violations(file, source).length, file + ': ' + source);
  for (const file of ['config.ts', 'cli.ts', 'ordinary.ts']) assert.ok(violations(file, resolutionGuard.import).length, file);
  const source = await readFile(new URL('../src/system-runtime-preflight.ts', import.meta.url), 'utf8');
  assert.deepEqual(violations(resolutionGuard.file, source), []);
  assert.ok(violations(resolutionGuard.file, source + '\nconst exposed = NodeModule;').length,
    'the reviewed module cannot transfer its Module capability outside the pinned guard');
  const altered = source.replace('process.versions.node', 'process.versions.node + \'altered\'');
  assert.notEqual(altered, source, 'the guard must verify its supported Node runtime');
  assert.ok(violations(resolutionGuard.file, altered).length, 'changed guard code requires independent capability review');
  const parsed = ts.createSourceFile(resolutionGuard.file, source, ts.ScriptTarget.Latest, true);
  const guard = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === resolutionGuard.owner)!;
  const relocated = source.replace(guard.getText(parsed), `function nested() {${guard.getText(parsed)}}`);
  assert.ok(violations(resolutionGuard.file, relocated).length, 'the reviewed guard cannot move into another lexical scope');
});

test('S5-07: fresh journal bootstrap and storage creation have no process or tool execution authority', async () => {
  for (const file of ['runner/journal-bootstrap.ts', 'runner/storage-creation.ts']) {
    const source = await readFile(join(packageRoot, sourcePrefix, file), 'utf8');
    assert.deepEqual(violations(file, source), []);
    for (const acquisition of [
      `import {spawn} from 'node:child_process'; spawn(binary, []);`,
      `import {runCommand} from '../config.js'; await runCommand(binary, []);`,
      `import {createLinuxContainmentBackend} from './linux-containment.js'; createLinuxContainmentBackend(options);`,
    ]) assert.ok(executionInventory(file, source + '\n' + acquisition).violations.length > 0,
      file + ' must not inherit an execution allowance: ' + acquisition);
  }
});

test('S4: aliases, dynamic imports, createRequire, native bindings and re-exports cannot acquire raw dispatch', () => {
  for (const source of [
    `import {spawn as launch} from 'node:child_process'; launch(binary, args);`,
    `import * as child from 'child_process'; child.spawn(binary, args);`,
    `const {spawn: launch} = await import('node:child_process'); launch(binary, args);`,
    `const load = require; load('node:child_process');`,
    `import {createRequire as load} from 'node:module'; load(import.meta.url)('node:child_process');`,
    `const load = createRequire(import.meta.url); const child = load('node:' + 'child_process');`,
    `process.binding('spawn_sync');`, `const native = process['bind' + 'ing'];`,
    `const key = 'getBuiltinModule'; const child = process[key]('child' + '_process'); child.spawn(binary, args);`,
    `const key = 'bin' + 'ding'; const native = process[key]; native('spawn_sync').spawn(options);`,
    `const {['get' + 'BuiltinModule']: load} = process; load('child' + '_process').spawn(binary, args);`,
    `import {binding as native} from 'node:process'; native('spawn_sync');`,
    `const {binding: native} = process;`, `process.getBuiltinModule('child_process');`,
    `export {spawn as launch} from 'node:child_process';`,
    `import {runCommand} from './config.js'; const execute = process.platform === 'darwin' ? runToolCommand : runCommand;`,
    `const {runCommand: launch} = await import('./config.js'); await launch(binary, ['--version']);`,
    `export {runCommand as launch} from './config.js';`,
    `import {runCommand as raw} from './config.js'; export const local = (...args) => raw(...args);`,
    `import {createRuntimeRunner as raw} from './config.js'; const launch = raw(runtime);`,
    `import {createSecretServiceRunner as raw} from './config.js'; const launch = raw(binary);`,
    `import {withClaimedToolCommands as claim} from './tool-command.js';`,
    `import {currentClaimedToolOperation as operation} from './tool-command.js';`,
    `const {currentClaimedToolOperation} = await import('./tool-command.js');`,
    `export {currentClaimedToolOperation} from './tool-command.js';`,
    `const {startTool} = await import('./runner/process.js');`,
    `const {runLinuxToolCommand} = await import('./runner/linux-lifecycle.js?bypass');`,
  ]) assert.ok(violations('npm.ts', source).length, source);
  assert.deepEqual(violations('plain.ts', `import type {ChildProcess} from 'node:child_process'; const value = /x/.exec(text);`), []);
  assert.ok(violations('shared/new-runtime.ts', `import {execFile} from 'node:child_process';`).length);
});

test('S5 selected login and provider capabilities stay in controller preflight and retained cleanup', () => {
  for (const [binding, module, owner] of [
    ['LinuxSelectedLogin', 'linux-selected-login', 'runner/linux-lifecycle.ts'],
    ['completeSelectedLogin', 'linux-selected-login', 'runner/linux-containment.ts'],
    ['prepareProviderLogin', 'linux-login-provider', 'runner/linux-selected-login.ts'],
  ]) {
    const source = `import {${binding}} from './${module}.js';`;
    assert.deepEqual(executionInventory(owner, source).violations, []);
    for (const file of ['runner/process.ts', 'runner/linux-lifecycle.ts', 'runner/linux-containment.ts', 'runner/adapters/codex.ts']) {
      if (file === owner) continue;
      const path = file.includes('/adapters/') ? `../${module}.js` : `./${module}.js`;
      assert.ok(executionInventory(file, `import {${binding} as acquire} from '${path}';`).violations.length, file);
    }
    assert.ok(executionInventory(owner, `const {${binding}} = await import('./${module}.js');`).violations.length,
      'dynamic imports cannot expand the credential interface');
    assert.ok(executionInventory(owner, `export {${binding}} from './${module}.js';`).violations.length,
      'an admitted importer cannot forward credential authority');
  }
  for (const file of ['runner/linux-selected-login.ts', 'runner/linux-login-provider.ts']) {
    for (const source of [
      `import {spawn} from 'node:child_process';`,
      `import {runCommand} from '../config.js';`,
      `import {startTool} from './process.js';`,
      `import {runLinuxToolCommand} from './linux-lifecycle.js';`,
    ]) assert.ok(executionInventory(file, source).violations.length, `${file}: ${source}`);
  }
  assert.deepEqual(executionInventory('runner/process.ts', `import type {LinuxSelectedLogin} from './linux-selected-login.js';`).violations, []);
  assert.deepEqual(executionInventory('runner/process.ts', `import {selectedLoginFailure} from './linux-login-provider.js';`).violations, [],
    'sanitized error classification grants no refresh authority');
});

test('S5-07 local provider preparation stays data-only and production callers cannot select fixture paths', async () => {
  const authority: [string, string[]][] = [
    ['prepareLinuxLocalProvider', ['runner/runner.ts', 'runner/runs-on.ts']],
    ['preparedLinuxLocalProvider', ['runner/process.ts']],
    ['revalidateLinuxLocalProvider', ['runner/linux-lifecycle.ts', 'runner/linux-containment.ts']],
  ];
  for (const [binding, approved] of authority) {
    const source = `import {${binding}} from './linux-local-provider.js';`;
    for (const file of ['runner/runner.ts', 'runner/runs-on.ts', 'runner/process.ts', 'runner/linux-lifecycle.ts', 'runner/linux-containment.ts']) {
      assert.equal(executionInventory(file, source).violations.length, approved.includes(file) ? 0 : 1, `${binding}: ${file}`);
    }
    assert.ok(executionInventory(approved[0], `export {${binding}} from './linux-local-provider.js';`).violations.length);
    assert.ok(executionInventory(approved[0], `const {${binding}} = await import('./linux-local-provider.js');`).violations.length);
  }
  for (const file of ['runner/runner.ts', 'runner/runs-on.ts']) {
    const text = await readFile(join(packageRoot, sourcePrefix, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let preparations = 0;
    const visit = (node: ts.Node): void => {
      let providerPreparation = false;
      const preparationReference = (entry: ts.Node): void => {
        if (ts.isIdentifier(entry) && entry.text === 'prepareLinuxLocalProvider') providerPreparation = true;
        ts.forEachChild(entry, preparationReference);
      };
      if (ts.isCallExpression(node)) preparationReference(node.expression);
      if (ts.isCallExpression(node) && providerPreparation) {
        preparations++;
        assert.equal(node.arguments.length, 1, 'production preparation uses the fixed root-owned inventory, never synthetic path/UID options');
        assert.equal(ts.isSpreadElement(node.arguments[0]), false);
      }
      ts.forEachChild(node, visit);
    };
    visit(source); assert.ok(preparations > 0, file);
  }
  for (const code of [
    `import {spawn} from 'node:child_process';`,
    `import {runCommand} from '../config.js';`,
    `import {startTool} from './process.js';`,
    `import {runLinuxToolCommand} from './linux-lifecycle.js';`,
  ]) assert.ok(executionInventory('runner/linux-local-provider.ts', code).violations.length, code);
});

test('S4: every Node process, worker and native-addon execution entrypoint requires a reviewed acquisition', () => {
  const forbidden = [
    ...['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].map(name =>
      `import {${name} as launch} from 'node:child_process'; const alias = launch; alias(binary, args);`),
    `import cluster from 'node:cluster'; cluster.setupPrimary({exec: binary}); cluster.fork();`,
    `import * as cluster from 'cluster'; cluster.setupMaster({exec: binary}); cluster.fork();`,
    `import {fork as launch, setupPrimary} from 'node:cluster'; setupPrimary({exec: binary}); launch();`,
    `const {default: cluster} = await import('node:cluster'); cluster.fork();`,
    `export {fork as launch} from 'node:cluster';`,
    `import {Worker as Launch} from 'node:worker_threads'; new Launch(source, {eval: true});`,
    `import {Worker} from 'worker_threads'; new Worker(new URL('./worker.js', import.meta.url));`,
    `const {Worker} = await import('node:worker_threads'); new Worker(filename);`,
    `process.execve(binary, args, {});`,
    `process.execve?.(binary, args, {});`,
    `const launch = process.execve; launch?.(binary, args, {});`,
    `const {execve: launch} = process; launch(binary, args, {});`,
    `process['exec' + 've']?.(binary, args, {});`,
    `import {execve as launch} from 'node:process'; launch(binary, args, {});`,
    `const {execve: launch} = await import('node:process'); launch(binary, args, {});`,
    `export {execve as launch} from 'node:process';`,
    `process.dlopen(module, filename);`,
    `const launch = process.dlopen; launch(module, filename);`,
    `process['dl' + 'open'](module, filename);`,
    `import {dlopen as launch} from 'node:process'; launch(module, filename);`,
  ];
  // Check both an ordinary module and the existing raw-bearing modules: a
  // reviewed child_process import grants no new cluster/worker/process API.
  for (const file of ['npm.ts', 'config.ts', 'runner/process.ts']) for (const source of forbidden) {
    assert.ok(executionInventory(file, source).violations.length, `${file}: ${source}`);
  }
  assert.ok(violations('npm.ts', `const source = 'process.execve(binary, args, {})';`).length,
    'opaque executable source requires review too');
  assert.deepEqual(violations('plain.ts', `import {runInThisContext} from 'node:vm'; runInThisContext(source); const match = /x/.exec(text);`), [],
    'vm evaluates JavaScript in-process and is not an OS execution primitive');
});

test('S4: only the CLI may acquire the selected Secret Service execution capability', () => {
  for (const source of [
    `import {SecretServiceSecretStore as Store} from './secret-store.js'; new Store(endpoint, data, binary);`,
    `import {selectSecretStore as select} from './secret-store.js'; await select(options);`,
    `import * as stores from './secret-store.js'; new stores.SecretServiceSecretStore(endpoint, data, binary);`,
    `const {SecretServiceSecretStore: Store} = await import('./secret-store.js'); new Store(endpoint, data, binary);`,
    `const {selectSecretStore: select} = await import('./secret-store.js'); await select(options);`,
    `export {SecretServiceSecretStore as Store} from './secret-store.js';`,
    `import {selectSecretStore as select} from './secret-store.js'; export {select};`,
  ]) assert.ok(executionInventory('npm.ts', source).violations.length, source);
  assert.deepEqual(violations('cli-main.ts', `import {SecretServiceSecretStore, selectSecretStore} from './secret-store.js';`), []);
  assert.ok(violations('cli.ts', `import {SecretServiceSecretStore, selectSecretStore} from './secret-store.js';`).length,
    'the preflight facade cannot acquire application execution capabilities');
  assert.deepEqual(violations('plain.ts', `import type {SecretServiceSecretStore} from './secret-store.js';`), []);
  assert.deepEqual(violations('token.ts', `import {requireCredentialCapability} from './secret-store.js';`), []);
});

test('S4: reviewer mutations of existing runtime dispatch bindings fail', async () => {
  const npm = await readFile(new URL('../src/npm.ts', import.meta.url), 'utf8');
  assert.deepEqual(violations('npm.ts', npm), []);
  const conditional = npm.replace("import { HelperError, cleanEnvironment } from './config.js';", "import { HelperError, cleanEnvironment, runCommand } from './config.js';")
    .replace('const execute = runToolCommand;', "const execute = process.platform === 'darwin' ? runToolCommand : runCommand;");
  assert.notEqual(conditional, npm);
  assert.ok(violations('npm.ts', conditional).length);
  assert.ok(violations('npm.ts', npm + `\nconst {runCommand: launch} = await import('./config.js'); await launch(binary, ['--version']);`).length);
  const proc = await readFile(new URL('../src/linux-proc.ts', import.meta.url), 'utf8');
  for (const added of ['export default spawn;', 'export {spawn as launch};', 'export const launch = spawn;']) {
    assert.ok(violations('linux-proc.ts', proc + '\n' + added).length, added);
  }
});

test('S4: offline package, release and qualification scripts cannot enter runtime imports or package allowlists', async () => {
  // Source exports retain build/release tools for maintainers. Their wrappers
  // may use aliases freely because none is reachable or shipped as runtime.
  const scripts = ['check-package.mjs', 'prepare-release.mjs', 'qualify-linux-containment.mjs', 'run-linux-containment-native.mjs', 'provision-linux-tools.mjs'];
  const {allowedRuntimePath, checkCompiledImports, modules} = await import(new URL('../scripts/check-package.mjs', import.meta.url).href);
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files, ['dist', 'README.md', 'LICENSE', 'docs/install.md'], 'npm pack must exclude source and offline scripts');
  assert.equal(pkg.exports, undefined, 'offline scripts must not be public package exports');
  assert.ok(modules.every((name: string) => !offlineModule(name)), 'the shared export/runtime allowlist must exclude scripts');
  for (const script of scripts) {
    for (const source of [
      `import {main as command} from './scripts/${script}'; const launch = command; launch(binary, [], root);`,
      `import './scripts/${script}';`,
      `import './%73cripts/${script}';`,
      `export * from './scripts/${script}';`,
      `const {main: launch} = await import('./scripts/${script}'); launch(binary, [], root);`,
      `const name = './scripts/${script}'; await import(name);`,
    ]) assert.ok(violations('npm.ts', source).length, source);
    for (const path of [`scripts/${script}`, `src/scripts/${script}`, `dist/scripts/${script}`, `dist/helper/scripts/${script}`]) {
      assert.equal(allowedRuntimePath(path), false, `runtime package admitted ${path}`);
      assert.throws(() => checkCompiledImports('dist/npm.js', `import '../${path}';`, ['dist/npm.js', path], {}), /Unreviewed compiled helper import/u);
    }
  }
  // The release archive has its own narrower pack list. Check the data list,
  // without pinning the implementation or call sites of offline wrappers.
  const release = await readFile(join(packageRoot, 'scripts/prepare-release.mjs'), 'utf8');
  const tree = ts.createSourceFile('prepare-release.mjs', release, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let files: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'runtimePackage' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const property = node.initializer.properties.find(entry => ts.isPropertyAssignment(entry) && entry.name.getText(tree) === 'files');
      if (property && ts.isPropertyAssignment(property)) files = property.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(files && ts.isArrayLiteralExpression(files), 'runtime release must declare its pack allowlist');
  assert.deepEqual(files.elements.map(entry => literal(entry)), ['dist', 'npm-shrinkwrap.json', 'LICENSE']);
});

test('S4: allowances cannot be copied into other files or exported source roots', () => {
  for (const prefix of ['', 'src/']) {
    assert.equal(canonicalSourceFile(`${prefix}config.ts`, prefix), 'config.ts');
    for (const path of ['nested/config.ts', '../src/config.ts', prefix ? 'config.ts' : 'src/config.ts']) {
      assert.ok(violations(canonicalSourceFile(path, prefix), `import {execFile} from 'node:child_process';`).length);
    }
  }
});

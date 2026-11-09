import {posix, relative} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// The exporter relocates runner URLs into src/runner. Keep exactly one sink
// relative to this package root, rather than allowing either layout everywhere.
export const signalGate = relative(fileURLToPath(new URL('../../', import.meta.url)),
  fileURLToPath(new URL('../../src/runner/signal-gate.ts', import.meta.url))).split('\\').join('/');
const guardianFile = relative(fileURLToPath(new URL('../../', import.meta.url)),
  fileURLToPath(new URL('../../src/runner/linux-guardian.ts', import.meta.url))).split('\\').join('/');
// Only this reviewed native program may contain Python's self-group TERM sink.
// S4 exec-proof review retains the sole original self-group TERM sink and
// invariant checks. The private read-only task descriptor adds no recipient.
// Admission teardown review documents kernel-only closure; signal scope is unchanged.
// S5 private-channel handoff replaces only bootstrap transport. The self-group
// TERM, admission validation, and live task exec proof functions are unchanged.
// S5 exec-error distinguishes syscall failure only; sealing and signal scope stay unchanged.
// S5 output EOF proof redirects inherited fd1/fd2 only after spawn; the exact
// self-group TERM sink, retained namespace transport and admission checks remain.
// S5-07 adds only a retained provider pidfd SIGKILL in the private monitor.
// It is opened while its unreaped child identity is still owned. The original
// outer self-group TERM guard is unchanged. Pin both programs independently;
// other code in their module remains subject to the generic source scan.
// Fix 3 acknowledges monitor registration before fork and shares an unread
// cancellation socket through both exec boundaries; signal authority is unchanged.
// S5-07 s5.7.2 pins Qwen3 and validates the inherited immutable provider cwd.
// The directory FD is CLOEXEC; retained pidfd signal recipients and scope are unchanged.
const guardianDigests: Record<string, string> = {
  LINUX_INNER_LAUNCHER: '332ca14121c178ff7adc8896aa82ffb94365e6acd94ab398dd1cdcf4b9c393d5',
  LINUX_GUARDIAN: '7fa290d4fef874ef0fa9d15caa8f2e27f8706c15d4c5ffd17bb3f45fabef525d',
};
const forbiddenNames = new Set(['kill', '_kill', 'signalGroup', 'pidfd_send_signal']);
const executionNames = new Set(['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork', 'runCommand']);
const writeNames = new Set(['write', 'writev', 'writevSync', 'writeSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']);
const callableNames = new Set([...executionNames, ...writeNames]);
const unknownText = '\uFFFC';
const signalUtility = /(?:^|[;&|\n])\s*(?:(?:exec|sudo)\s+)*["']?(?:[^\s"';&|]*\/)?(?:kill|pkill|killall)(?=["'\s]|$)/u;
export type SignalViolation = {file: string; line: number; text: string};
type Callable = {name: string; bound: readonly ts.Expression[]};

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

/** Check executable syntax, including string/template source such as sessionGuardian. */
export function rawSignals(file: string, text: string): SignalViolation[] {
  const normalizedFile = posix.normalize(file.split('\\').join('/'));
  const violations: SignalViolation[] = [];
  const scannedStrings = new Set<string>();
  let allowedSinks = 0;
  let allowedContainmentSinks = 0;
  const scan = (sourceText: string, embedded: boolean, origin = 0, depth = 0): void => {
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true,
      /\.[cm]?jsx?$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    // Binding identifiers through the checker preserves lexical scope. A flat
    // identifier map could let an unrelated declaration hide a kill constant.
    const host = ts.createCompilerHost({});
    host.getSourceFile = name => name === file ? source : undefined;
    host.fileExists = name => name === file;
    host.readFile = name => name === file ? sourceText : undefined;
    const checker = ts.createProgram([file], {noLib: true, noResolve: true, allowJs: true}, host).getTypeChecker();
    const declarations = (node: ts.Identifier): readonly ts.Declaration[] => checker.getSymbolAtLocation(node)?.declarations ?? [];
    const initializer = (node: ts.Identifier, constantOnly = true): ts.Expression | undefined => {
      for (const declaration of declarations(node)) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) &&
          (!constantOnly || declaration.parent.flags & ts.NodeFlags.Const)) return declaration.initializer;
      }
      return undefined;
    };
    const constantText = (input: ts.Expression | undefined, seen = new Set<ts.Node>()): string => {
      if (!input) return unknownText;
      const node = unwrap(input);
      if (seen.has(node)) return unknownText;
      const next = new Set([...seen, node]);
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
      if (ts.isIdentifier(node)) return constantText(initializer(node), next);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return constantText(node.left, next) + constantText(node.right, next);
      }
      if (ts.isTemplateExpression(node)) {
        return node.head.text + node.templateSpans.map(span => constantText(span.expression, next) + span.literal.text).join('');
      }
      return unknownText;
    };
    const propertyName = (node: ts.PropertyName | undefined): string | undefined => !node ? undefined :
      ts.isComputedPropertyName(node) ? constantText(node.expression) : ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    const bindingName = (node: ts.BindingElement): string | undefined => node.propertyName ? propertyName(node.propertyName) :
      ts.isIdentifier(node.name) ? node.name.text : undefined;
    const memberName = (node: ts.Expression): string | undefined => ts.isPropertyAccessExpression(node) ? node.name.text :
      ts.isElementAccessExpression(node) ? constantText(node.argumentExpression) : undefined;
    const memberOwner = (node: ts.Expression): ts.Expression | undefined =>
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;
    const processObject = (input: ts.Expression, seen = new Set<ts.Node>()): boolean => {
      const node = unwrap(input);
      if (seen.has(node)) return false;
      const next = new Set([...seen, node]);
      if (ts.isIdentifier(node)) {
        if (node.text === 'process') return true;
        const value = initializer(node, false);
        if (value && processObject(value, next)) return true;
        return declarations(node).some(declaration => {
          const clause = ts.isImportClause(declaration) ? declaration : ts.isNamespaceImport(declaration) ? declaration.parent : undefined;
          return !!clause && ts.isImportClause(clause) && ts.isStringLiteral(clause.parent.moduleSpecifier) &&
            ['process', 'node:process'].includes(clause.parent.moduleSpecifier.text);
        });
      }
      return ts.isPropertyAccessExpression(node) && node.name.text === 'process' && ts.isIdentifier(node.expression) && node.expression.text === 'globalThis';
    };
    const arrayArguments = (input: ts.Expression | undefined, seen = new Set<ts.Node>()): readonly ts.Expression[] => {
      if (!input) return [];
      const node = unwrap(input);
      if (seen.has(node)) return [];
      const next = new Set([...seen, node]);
      if (ts.isIdentifier(node)) return arrayArguments(initializer(node, false), next);
      return ts.isArrayLiteralExpression(node) ? node.elements.flatMap(element =>
        ts.isSpreadElement(element) ? arrayArguments(element.expression, next) : [element]) : [];
    };
    const expandArguments = (args: readonly ts.Expression[]): readonly ts.Expression[] => args.flatMap(argument =>
      ts.isSpreadElement(argument) ? arrayArguments(argument.expression) : [argument]);
    const callable = (input: ts.Expression | undefined, seen = new Set<ts.Node>()): Callable | undefined => {
      if (!input) return undefined;
      const node = unwrap(input);
      if (seen.has(node)) return undefined;
      const next = new Set([...seen, node]);
      if (ts.isIdentifier(node)) {
        const value = initializer(node, false);
        if (value) return callable(value, next);
        for (const declaration of declarations(node)) {
          const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text :
            ts.isBindingElement(declaration) ? bindingName(declaration) : undefined;
          if (name && callableNames.has(name)) return {name, bound: []};
        }
        return callableNames.has(node.text) ? {name: node.text, bound: []} : undefined;
      }
      const name = memberName(node), owner = memberOwner(node);
      if (name && callableNames.has(name) && owner && !ts.isRegularExpressionLiteral(unwrap(owner))) return {name, bound: []};
      if (ts.isCallExpression(node)) {
        if (memberName(node.expression) === 'bind') {
          const target = callable(memberOwner(node.expression), next);
          if (target) return {...target, bound: [...target.bound, ...expandArguments(node.arguments).slice(1)]};
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'promisify') return callable(node.arguments[0], next);
      }
      return undefined;
    };
    const commandInvocation = (node: ts.CallExpression): {target: Callable; args: readonly ts.Expression[]} | undefined => {
      const args = expandArguments(node.arguments);
      const method = memberName(node.expression);
      if (method === 'call' || method === 'apply' || method === 'bind') {
        const target = callable(memberOwner(node.expression));
        if (!target) return undefined;
        const supplied = method === 'apply' ? arrayArguments(args[1]) : args.slice(1);
        return {target, args: [...target.bound, ...supplied]};
      }
      const target = callable(node.expression);
      return target ? {target, args: [...target.bound, ...args]} : undefined;
    };
    const explicitSignalUtility = (node: ts.CallExpression): boolean => {
      const invocation = commandInvocation(node);
      if (!invocation || !executionNames.has(invocation.target.name)) return false;
      const command = constantText(invocation.args[0]);
      if (/(?:^|\/)(?:kill|pkill|killall)$/u.test(command) || signalUtility.test(command)) return true;
      if (!/(?:^|\/)(?:(?:ba|da|z|k)?sh|env)$/u.test(command)) return false;
      return arrayArguments(invocation.args[1]).some(argument => /(?:^|\/)(?:kill|pkill|killall)$/u.test(constantText(argument)) || signalUtility.test(constantText(argument)));
    };
    const computedProcessBinding = (node: ts.BindingElement): boolean => {
      const declaration = node.parent.parent;
      return !!node.propertyName && ts.isComputedPropertyName(node.propertyName) && ts.isVariableDeclaration(declaration) &&
        !!declaration.initializer && processObject(declaration.initializer);
    };
    const reflectiveSignalAccess = (node: ts.CallExpression): boolean => {
      const owner = memberOwner(node.expression);
      return !!owner && ts.isIdentifier(owner) && owner.text === 'Reflect' && memberName(node.expression) === 'get' &&
        (!!node.arguments[0] && processObject(node.arguments[0]) || forbiddenNames.has(constantText(node.arguments[1])));
    };
    // Unknown computed calls are forbidden regardless of their receiver. Keep
    // ordinary indexed data reads valid; literal/const benign methods resolve above.
    const computedCall = (node: ts.ElementAccessExpression): boolean => {
      let use: ts.Node = node;
      while (use.parent && (ts.isParenthesizedExpression(use.parent) || ts.isAsExpression(use.parent) ||
        ts.isNonNullExpression(use.parent) || ts.isSatisfiesExpression(use.parent) ||
        ts.isPropertyAccessExpression(use.parent) && ['call', 'apply', 'bind'].includes(use.parent.name.text))) use = use.parent;
      return ts.isCallExpression(use.parent) && use.parent.expression === use;
    };
    const allowedSink = (node: ts.Node): boolean => {
      if (embedded || normalizedFile !== signalGate || !ts.isPropertyAccessExpression(node) ||
        !ts.isIdentifier(node.expression) || node.expression.text !== 'process' || node.name.text !== 'kill' ||
        !ts.isCallExpression(node.parent) || node.parent.expression !== node) return false;
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
      return !!parent && ts.isFunctionDeclaration(parent) && parent.name?.text === 'signalIfStillOwned' &&
        parent.parent === source && parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    };
    const insideGate = (node: ts.Node): boolean => {
      if (embedded || normalizedFile !== signalGate) return false;
      let parent = node.parent;
      while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
      return !!parent && ts.isFunctionDeclaration(parent) && parent.name?.text === 'signalIfStillOwned' && parent.parent === source &&
        parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    };
    const cgroupDestination = (input: ts.Expression | undefined, seen = new Set<ts.Node>()): boolean => {
      if (!input) return false;
      const node = unwrap(input);
      if (seen.has(node)) return false;
      const next = new Set([...seen, node]);
      if (ts.isStringLiteralLike(node)) return /(?:^|\/)cgroup\.kill$/u.test(node.text);
      if (ts.isIdentifier(node)) return cgroupDestination(initializer(node, false), next);
      if (ts.isAwaitExpression(node)) return cgroupDestination(node.expression, next);
      if (ts.isObjectLiteralExpression(node)) return node.properties.some(property =>
        ts.isPropertyAssignment(property) ? cgroupDestination(property.initializer, next) :
        ts.isShorthandPropertyAssignment(property) ? !!checker.getShorthandAssignmentValueSymbol(property)?.declarations?.some(declaration =>
          ts.isVariableDeclaration(declaration) && cgroupDestination(declaration.initializer, next)) :
        ts.isSpreadAssignment(property) && cgroupDestination(property.expression, next));
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return cgroupDestination(node.expression, next);
      if (ts.isCallExpression(node)) return node.arguments.some(argument => cgroupDestination(argument, next));
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return /(?:^|\/)cgroup\.kill$/u.test(constantText(node));
      return false;
    };
    const cgroupWrite = (node: ts.CallExpression): boolean => {
      const invocation = commandInvocation(node);
      return !!invocation && writeNames.has(invocation.target.name) &&
        (invocation.args.some(argument => cgroupDestination(argument)) || cgroupDestination(memberOwner(node.expression)));
    };
    const report = (node: ts.Node): void => {
      if (allowedSink(node) && allowedSinks++ === 0) return;
      // An injectable sender may be handed to the gate as evidence. Invoking
      // it, storing it elsewhere or forwarding a raw kill primitive is banned.
      const property = node.parent;
      const object = property?.parent;
      const call = object?.parent;
      if (!embedded && ts.isPropertyAccessExpression(node) && node.name.text === 'signalGroup' &&
        property && ts.isPropertyAssignment(property) && property.initializer === node && propertyName(property.name) === 'sendGroup' &&
        object && ts.isObjectLiteralExpression(object) && call && ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) && call.expression.text === 'signalIfStillOwned' && call.arguments.includes(object)) return;
      violations.push({file, line: embedded ? origin : source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: `${embedded ? 'embedded JavaScript: ' : ''}${node.getText(source).slice(0, 160)}`});
    };
    const scanString = (value: string, node: ts.Node): void => {
      if (depth >= 4 || scannedStrings.has(value)) return;
      scannedStrings.add(value);
      // A control-file basename is data; writing it is checked separately.
      if (value === 'cgroup.kill') return;
      const tagged = node.parent, declaration = tagged?.parent;
      if (!embedded && normalizedFile === guardianFile && ts.isTaggedTemplateExpression(tagged) &&
        tagged.tag.getText(source) === 'String.raw' && declaration && ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) && Object.hasOwn(guardianDigests, declaration.name.text)) {
        const exact = node.getText(source).slice(1, -1);
        if (createHash('sha256').update(exact).digest('hex') === guardianDigests[declaration.name.text]) return;
        violations.push({file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: 'changed native guardian requires retained signal review'});
      }
      scan(value, true, embedded ? origin : source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, depth + 1);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && forbiddenNames.has(node.name.text)) report(node);
      else if (ts.isElementAccessExpression(node) &&
        (processObject(node.expression) || forbiddenNames.has(constantText(node.argumentExpression)) ||
          computedCall(node) && constantText(node.argumentExpression).includes(unknownText))) report(node);
      else if (ts.isImportSpecifier(node) && forbiddenNames.has((node.propertyName ?? node.name).text)) report(node);
      else if (ts.isExportSpecifier(node) && forbiddenNames.has((node.propertyName ?? node.name).text)) report(node);
      else if (ts.isBindingElement(node) && (forbiddenNames.has(bindingName(node) ?? '') || computedProcessBinding(node))) report(node);
      else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && forbiddenNames.has(node.expression.text)) report(node);
      else if (ts.isCallExpression(node) && explicitSignalUtility(node)) report(node);
      else if (ts.isCallExpression(node) && reflectiveSignalAccess(node)) report(node);
      else if (ts.isCallExpression(node) && (cgroupWrite(node) || normalizedFile === signalGate &&
        ts.isIdentifier(node.expression) && node.expression.text === 'writeSync')) {
        if (!(insideGate(node) && allowedContainmentSinks++ === 0)) report(node);
      }
      if (ts.isStringLiteralLike(node)) scanString(node.text, node);
      else if (ts.isTemplateExpression(node) || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        // Resolve concatenated/constant pieces before parsing embedded code.
        // Unknown interpolations are identifiers so adjacent syntax survives.
        scanString(constantText(node).replaceAll(unknownText, 'undefined'), node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  scan(text, false);
  return violations;
}

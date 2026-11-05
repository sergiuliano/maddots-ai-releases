import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_MATRIX, isLinuxAcceptanceCandidate, toolRunCapability, validateToolMatrix } from '../src/shared/tool-matrix.js';

test('every platform starts refused, independently of the legacy global offer', () => {
  for (const tool of TOOL_MATRIX.tools) {
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as const) {
      assert.notEqual(toolRunCapability(tool, platform)?.offered, true, `${tool.key}/${platform}`);
    }
    if (tool.run) assert.deepEqual(tool.run.platforms, {darwin: {accepted: false}, linux: {accepted: false}});
  }
  const codex = structuredClone(TOOL_MATRIX.tools.find(tool => tool.key === 'codex')!);
  codex.run!.offered = true;
  for (const platforms of [undefined, {}, {darwin: {accepted: false}, linux: {accepted: false}}]) {
    codex.run!.platforms = platforms;
    assert.equal(toolRunCapability(codex, 'darwin')!.offered, false);
    assert.equal(toolRunCapability(codex, 'linux')!.offered, false);
  }
  assert.equal(toolRunCapability(undefined, 'linux'), null);
  assert.equal(toolRunCapability(TOOL_MATRIX.tools.find(tool => tool.key === 'claude-desktop'), 'darwin'), null);
});

test('the closed Linux candidate set never grants acceptance or admits another tool', () => {
  assert.deepEqual(TOOL_MATRIX.tools.filter(isLinuxAcceptanceCandidate).map(tool => tool.key).sort(),
    ['claude-code', 'codex', 'opencode']);
  assert.equal(isLinuxAcceptanceCandidate(undefined), false);
  for (const source of TOOL_MATRIX.tools) {
    const tool = structuredClone(source);
    if (!tool.run) continue;
    tool.run.offered = true;
    tool.run.platforms = {darwin: {accepted: true}, linux: {accepted: false}};
    if (isLinuxAcceptanceCandidate(tool)) assert.equal(toolRunCapability(tool, 'linux')!.offered, false);
    else assert.equal(toolRunCapability(tool, 'linux'), null, tool.key);
  }
});

test('Linux candidates are Full access only independently of acceptance; Darwin keeps its access policy', () => {
  for (const key of ['codex', 'claude-code', 'opencode']) {
    const tool = structuredClone(TOOL_MATRIX.tools.find(tool => tool.key === key)!);
    for (const accepted of [false, true]) {
      tool.run!.platforms = {linux: {accepted}, darwin: {accepted}};
      assert.equal(toolRunCapability(tool, 'linux')!.folderOnly, 'none', key);
      assert.equal(toolRunCapability(tool, 'linux')!.offered, accepted, key);
      assert.equal(toolRunCapability(tool, 'darwin')!.folderOnly, tool.run!.folderOnly, key);
    }
  }
});

test('each Linux candidate needs its own acceptance and Darwin acceptance is independent', () => {
  const matrix = structuredClone(TOOL_MATRIX);
  for (const key of ['codex', 'claude-code', 'opencode']) {
    const tool = matrix.tools.find(tool => tool.key === key)!;
    tool.run!.offered = false;
    tool.run!.platforms = {darwin: {accepted: true}, linux: {accepted: false}};
    assert.equal(toolRunCapability(tool, 'darwin')!.offered, true);
    assert.equal(toolRunCapability(tool, 'linux')!.offered, false);
    tool.run!.platforms = {darwin: {accepted: false}, linux: {accepted: true}};
    assert.equal(toolRunCapability(tool, 'darwin')!.offered, false);
    assert.equal(toolRunCapability(tool, 'linux')!.offered, true);
    for (const other of matrix.tools.filter(other => other.key !== key)) {
      assert.notEqual(toolRunCapability(other, 'linux')?.offered, true, `${key} must not accept ${other.key}`);
    }
    tool.run!.platforms = {linux: {accepted: false}};
  }
});

test('future accepted eligible Linux tools retain ordinary admission without joining the candidate set', () => {
  for (const key of ['continue', 'vscode-copilot', 'deepseek-harness']) {
    const tool = structuredClone(TOOL_MATRIX.tools.find(tool => tool.key === key)!);
    assert.equal(isLinuxAcceptanceCandidate(tool), false);
    tool.run!.offered = false;
    tool.run!.platforms = {darwin: {accepted: false}, linux: {accepted: true}};
    assert.equal(toolRunCapability(tool, 'linux')!.offered, true, key);
    assert.equal(toolRunCapability(tool, 'darwin')!.offered, false, key);
    tool.run!.platforms = {darwin: {accepted: true}, linux: {accepted: false}};
    assert.equal(toolRunCapability(tool, 'linux'), null, key);
    assert.equal(toolRunCapability(tool, 'darwin')!.offered, true, key);
  }
});

test('Devin, sync-only variants and mismatched candidate adapters remain refused despite edited flags', () => {
  for (const source of TOOL_MATRIX.tools) {
    const tool = structuredClone(source);
    if (!tool.run) continue;
    tool.run.offered = true;
    tool.run.platforms = {darwin: {accepted: true}, linux: {accepted: true}};
    if (tool.key === 'devin' || tool.variants.find(variant => variant.key === 'cli')!.syncOnly) {
      assert.equal(toolRunCapability(tool, 'linux'), null, tool.key);
      assert.equal(toolRunCapability(tool, 'darwin'), null, tool.key);
    }
  }
  const devin = structuredClone(TOOL_MATRIX.tools.find(tool => tool.key === 'devin')!);
  devin.variants.forEach(variant => {variant.syncOnly = false;});
  devin.run!.platforms = {darwin: {accepted: true}, linux: {accepted: true}};
  assert.equal(toolRunCapability(devin, 'linux'), null);
  assert.equal(toolRunCapability(devin, 'darwin'), null);
  const codex = structuredClone(TOOL_MATRIX.tools.find(tool => tool.key === 'codex')!);
  codex.run!.platforms = {linux: {accepted: true}};
  codex.variants.find(variant => variant.key === 'cli')!.syncOnly = true;
  assert.equal(isLinuxAcceptanceCandidate(codex), false);
  assert.equal(toolRunCapability(codex, 'linux'), null);
  codex.variants.find(variant => variant.key === 'cli')!.syncOnly = false;
  codex.run!.adapter = 'cursor';
  assert.equal(isLinuxAcceptanceCandidate(codex), false);
  assert.equal(toolRunCapability(codex, 'linux'), null);
  codex.run!.adapter = 'devin';
  assert.equal(toolRunCapability(codex, 'darwin'), null);
});

test('platform metadata rejects malformed or unknown acceptance while missing maps refuse safely', () => {
  for (const platforms of [undefined, null, false, [], {win32: {accepted: true}}, {linux: true}, {linux: {}},
    {linux: {accepted: 'true'}}, {linux: {accepted: 1}}, {linux: {accepted: true, extra: false}}]) {
    const matrix = structuredClone(TOOL_MATRIX);
    Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {platforms});
    assert.throws(() => validateToolMatrix(matrix), /TOOL_MATRIX_INVALID: tools\[\d+\]\.run\.platforms/u);
  }
  for (const platforms of [{}, {linux: {accepted: false}}, {darwin: {accepted: true}}]) {
    const matrix = structuredClone(TOOL_MATRIX);
    matrix.tools.find(tool => tool.key === 'codex')!.run!.platforms = platforms;
    assert.doesNotThrow(() => validateToolMatrix(matrix));
  }
  const matrix = structuredClone(TOOL_MATRIX), codex = matrix.tools.find(tool => tool.key === 'codex')!;
  delete codex.run!.platforms;
  codex.run!.offered = true;
  assert.doesNotThrow(() => validateToolMatrix(matrix));
  assert.equal(toolRunCapability(codex, 'linux')!.offered, false);
  for (const platform of ['darwin', 'linux'] as const) {
    const grok = matrix.tools.find(tool => tool.key === 'grok')!;
    grok.run!.platforms = {[platform]: {accepted: true}};
    assert.throws(() => validateToolMatrix(matrix), /TOOL_MATRIX_INVALID: tools\[\d+\]\.run$/u);
  }
});

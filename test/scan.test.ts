import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { SECRET_RULES } from '../src/shared/skill-checks/secret-rules.js';
import { scanFiles, type ScanFile } from '../src/scan.js';

// Construct conspicuously synthetic samples, with no copied or live credentials.
const syntheticSuffix = 'SYNTHETIC_TEST_ONLY_'.repeat(2);
const syntheticLetters = 'SYNTHETICTESTONLY'.repeat(3);
const syntheticAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789';
const maddotsToken = ['pm', 'run', syntheticSuffix].join('_');
const skillToken = ['mdai', 'skill', syntheticSuffix].join('_');
const samples: Readonly<Record<string, string>> = {
  'private-key': '-----BEGIN PRIVATE KEY-----',
  'aws-key': ['AK', 'IA', 'TESTONLY'.repeat(2)].join(''),
  'github-token': ['ghp', syntheticLetters].join('_'),
  'openai-key': ['sk', 'proj', syntheticSuffix].join('-'),
  'anthropic-key': ['sk', 'ant', syntheticSuffix].join('-'),
  'slack-token': ['xoxb', syntheticLetters].join('-'),
  'stripe-live-key': ['sk', 'live', syntheticLetters].join('_'),
  'google-api-key': ['AI', 'za', syntheticSuffix.slice(0, 35)].join(''),
  jwt: ['eyJ' + syntheticLetters, 'SYNTHETIC_PAYLOAD', 'SYNTHETIC_SIGNATURE'].join('.'),
  'url-password': 'https://synthetic-user:synthetic-password@example.test',
  'maddots-token': maddotsToken,
  'mdai-skill-token': skillToken,
  'high-entropy-assignment': `api_key: "${syntheticAlphabet}"`,
};

function assertRedacted(result: unknown, values: readonly string[]) {
  const serialized = JSON.stringify(result);
  for (const value of values) assert.equal(serialized.includes(value), false, 'Scanner output must omit input credential text.');
}

test('empty, plain text, required secret names and binary bytes are clean and unchanged', () => {
  assert.deepEqual(scanFiles([]), { blocked: false, findings: [] });
  const files = [
    { path: 'SKILL.md', content: Buffer.from('Use HUNTER_API_KEY from your environment.\n') },
    { path: 'assets/image.bin', content: Buffer.from([0, 255, 1, 128, 2]) },
    { path: 'empty.txt', content: Buffer.alloc(0) },
    { path: 'settings.txt', content: Buffer.from('api_key: AAAAAAAAAAAAAAAAAAAAAAAA\n') },
  ];
  const original = files.map(file => ({ path: file.path, content: Buffer.from(file.content) }));
  assert.deepEqual(scanFiles(files), { blocked: false, findings: [] });
  assert.deepEqual(files, original);
});

test('findings preserve 1-based lines across CRLF, CR, LF and a UTF-8 BOM without matches', () => {
  const content = Buffer.from(`\uFEFFPlain Unicode: café\r\n${maddotsToken} ${maddotsToken}\rclean\n${maddotsToken}\n`);
  const original = Buffer.from(content);
  const result = scanFiles([{ path: 'output.txt', content }]);
  assertRedacted(result, [maddotsToken]);
  assert.deepEqual(result, { blocked: true, findings: [
    { rule: 'maddots-token', path: 'output.txt', line: 2 },
    { rule: 'maddots-token', path: 'output.txt', line: 4 },
  ] });
  assert.ok(result.findings.every(finding => Object.keys(finding).join(',') === 'rule,path,line'));
  assert.equal(content.equals(original), true, 'Scanning must not change input bytes.');
});

test('all file types and removed server files are scanned, including malformed UTF-8', () => {
  const content = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from(`\n${skillToken}\n`)]);
  const files = ['assets/data.bin', 'hooks.json', '.mcp.json', 'commands/run.md', 'agents/run.md']
    .map(path => ({ path, content }));
  const result = scanFiles(files);
  assertRedacted(result, [skillToken]);
  assert.deepEqual(result, { blocked: true, findings: files.map(({ path }) => ({ rule: 'mdai-skill-token', path, line: 2 })) });
});

test('filename secrets block and every finding from that file redacts its path', () => {
  const result = scanFiles([{ path: `references/${maddotsToken}.md`, content: Buffer.from('clean\n-----BEGIN PRIVATE KEY-----\n') }]);
  assertRedacted(result, [maddotsToken]);
  assert.deepEqual(result, { blocked: true, findings: [
    { rule: 'maddots-token', path: '[redacted]', line: 1 },
    { rule: 'private-key', path: '[redacted]', line: 2 },
  ] });
});

test('all filename findings precede contents and contents retain file order', () => {
  const result = scanFiles([
    { path: 'references/first.md', content: Buffer.from('clean\n-----BEGIN PRIVATE KEY-----\n') },
    { path: `references/${maddotsToken}.md`, content: Buffer.from(`clean\n${skillToken}\n`) },
    { path: `references/${skillToken}.md`, content: Buffer.from('clean') },
  ]);
  assertRedacted(result, [maddotsToken, skillToken]);
  assert.deepEqual(result, { blocked: true, findings: [
    { rule: 'maddots-token', path: '[redacted]', line: 1 },
    { rule: 'mdai-skill-token', path: '[redacted]', line: 1 },
    { rule: 'private-key', path: 'references/first.md', line: 2 },
    { rule: 'mdai-skill-token', path: '[redacted]', line: 2 },
  ] });
});

test('deduplication uses the original filename before redaction', () => {
  const files = [
    { path: `first/${maddotsToken}.txt`, content: Buffer.from(maddotsToken) },
    { path: `second/${maddotsToken}.txt`, content: Buffer.from(maddotsToken) },
  ];
  const result = scanFiles([...files, files[0]]);
  assertRedacted(result, [maddotsToken]);
  assert.deepEqual(result, { blocked: true, findings: [
    { rule: 'maddots-token', path: '[redacted]', line: 1 },
    { rule: 'maddots-token', path: '[redacted]', line: 1 },
  ] });
});

test('repeated scans ignore exported regex cursors and retain later entropy matches', () => {
  const files = [{ path: 'settings.txt', content: Buffer.from(`key: AAAAAAAAAAAAAAAAAAAAAAAA; secret: ${syntheticAlphabet}\n`) }];
  const expected = { blocked: true, findings: [{ rule: 'high-entropy-assignment', path: 'settings.txt', line: 1 }] };
  const cursors = SECRET_RULES.map(rule => rule.pattern.lastIndex);
  try {
    for (const rule of SECRET_RULES) rule.pattern.lastIndex = 100000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = scanFiles(files);
      assertRedacted(result, [syntheticAlphabet]);
      assert.deepEqual(result, expected);
    }
  } finally { SECRET_RULES.forEach((rule, index) => { rule.pattern.lastIndex = cursors[index]; }); }
});

test('over-limit files block at line 1 and other files are still scanned', () => {
  const result = scanFiles([
    { path: 'assets/oversized.bin', content: Buffer.alloc(1024 * 1024 + 1) },
    { path: 'references/other.md', content: Buffer.from(maddotsToken) },
    { path: `references/${skillToken}.md`, content: Buffer.from('é'.repeat(512 * 1024 + 1)) },
  ]);
  assertRedacted(result, [maddotsToken, skillToken]);
  assert.deepEqual(result, { blocked: true, findings: [
    { rule: 'mdai-skill-token', path: '[redacted]', line: 1 },
    { rule: 'file-size-limit', path: 'assets/oversized.bin', line: 1 },
    { rule: 'maddots-token', path: 'references/other.md', line: 1 },
    { rule: 'file-size-limit', path: '[redacted]', line: 1 },
  ] });
});

test('exactly 1 MiB is scanned through its final bytes', () => {
  const limit = 1024 * 1024;
  const suffix = Buffer.from(`\n${maddotsToken}`);
  const content = Buffer.concat([Buffer.alloc(limit - suffix.length, 32), suffix]);
  assert.equal(content.byteLength, limit);
  const result = scanFiles([{ path: 'references/exact.md', content }]);
  assertRedacted(result, [maddotsToken]);
  assert.deepEqual(result, { blocked: true, findings: [{ rule: 'maddots-token', path: 'references/exact.md', line: 2 }] });
  assert.deepEqual(scanFiles([{ path: 'assets/exact.bin', content: Buffer.alloc(limit) }]), { blocked: false, findings: [] });
});

for (const [name, source] of [
  ['key and scheme fragments', 'key.'.repeat(128 * 1024) + 'a.'.repeat(256 * 1024)],
  ['JWT fragments', 'eyJ-'.repeat(256 * 1024)],
]) test(`a 1 MiB adversarial line of ${name} scans in under one second`, () => {
  const content = Buffer.from(source);
  assert.equal(content.byteLength, 1024 * 1024);
  const started = performance.now();
  const result = scanFiles([{ path: 'references/adversarial.md', content }]);
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { blocked: false, findings: [] });
  assert.ok(elapsed < 1000, `Adversarial scan exceeded one second (${Math.round(elapsed)} ms).`);
});

const escapedPrefix = (kind: 'x' | 'u' | 'U') => [...'pm_run_'].map(character =>
  `\\${kind}${character.codePointAt(0)!.toString(16).padStart(kind === 'x' ? 2 : kind === 'u' ? 4 : 8, '0')}`).join('');
const yamlCases = [
  ...(['x', 'u', 'U'] as const).map(kind => ({ name: `${kind} escapes`, value: escapedPrefix(kind) + syntheticSuffix, decoded: maddotsToken, rule: 'maddots-token' })),
  { name: 'escaped AWS prefix', value: '\\x41' + samples['aws-key'].slice(1), decoded: samples['aws-key'], rule: 'aws-key' },
  { name: 'backslash continuation', value: 'pm_ru\\\n    n_' + syntheticSuffix, decoded: maddotsToken, rule: 'maddots-token' },
];
for (const path of ['SKILL.md', 'maddots.yaml']) for (const sample of yamlCases) test(`${path} scans ${sample.name} without exposing encoded or decoded values`, () => {
  const text = path === 'SKILL.md'
    ? `---\nname: example\n# Synthetic test scalar\ndescription: "${sample.value}"\n---\nUse the example.\n`
    : `category: development\nextras:\n  claude-code:\n    argument-hint: "${sample.value}"\n`;
  const result = scanFiles([{ path, content: Buffer.from(text) }]);
  assertRedacted(result, [sample.value, sample.decoded]);
  assert.deepEqual(result, { blocked: true, findings: [{ rule: sample.rule, path, line: 4 }] });
});

for (const path of ['SKILL.md', 'maddots.yaml']) test(`${path} maps an escaped token in a multiline scalar to its physical source line`, () => {
  const value = escapedPrefix('u') + syntheticSuffix;
  const text = path === 'SKILL.md'
    ? `---\nname: example\n# Synthetic test scalar\ndescription: "First line\n    ${value}"\n---\nUse the example.\n`
    : `category: development\nextras:\n  claude-code:\n    argument-hint: "First line\n      ${value}"\n`;
  const result = scanFiles([{ path, content: Buffer.from(text) }]);
  assertRedacted(result, [value, maddotsToken]);
  assert.deepEqual(result, { blocked: true, findings: [{ rule: 'maddots-token', path, line: 5 }] });
});

test('raw and decoded YAML findings are both retained and duplicate findings collapse', () => {
  const text = `---\nname: example\ndescription: "${maddotsToken} ${escapedPrefix('x') + syntheticSuffix}"\nmetadata:\n  note: "${skillToken}"\n---\n`;
  const result = scanFiles([{ path: 'SKILL.md', content: Buffer.from(text) }]);
  assertRedacted(result, [maddotsToken, skillToken]);
  assert.deepEqual(result, { blocked: true, findings: [
    { rule: 'maddots-token', path: 'SKILL.md', line: 3 },
    { rule: 'mdai-skill-token', path: 'SKILL.md', line: 5 },
  ] });
});

test('YAML decoding is restricted to double-quoted scalars in supported YAML locations', () => {
  const value = escapedPrefix('x') + syntheticSuffix;
  const files = [
    { path: 'references/example.md', content: Buffer.from(`description: "${value}"`) },
    { path: 'SKILL.md', content: Buffer.from(`---\nname: example\ndescription: Synthetic example\n---\ndescription: "${value}"`) },
    { path: 'maddots.yaml', content: Buffer.from(`category: development\n# "${value}"\nextras:\n  claude-code:\n    argument-hint: '${value}'\n`) },
  ];
  const result = scanFiles(files);
  assertRedacted(result, [value, maddotsToken]);
  assert.deepEqual(result, { blocked: false, findings: [] });
});

test('high-entropy environment references and file paths remain clean', () => {
  const values = [
    'X_KEY = os.environ.get("X_KEY")',
    'X_KEY = os.getenv("X_KEY")',
    'X_KEY = os.environ["SYNTHETIC_TEST_ONLY_ACCESS_KEY"]',
    'X_KEY=$SYNTHETIC_TEST_ONLY_ACCESS_KEY',
    'X_KEY="${SYNTHETIC_TEST_ONLY_ACCESS_KEY}"',
    'const X_KEY = process.env.SYNTHETIC_TEST_ONLY_ACCESS_KEY;',
    'const X_KEY = process.env["SYNTHETIC_TEST_ONLY_ACCESS_KEY"];',
    'X_KEY = "/opt/synthetic/credentials/ExampleAuthenticationToken.txt"',
    'X_KEY = "./synthetic/credentials/ExampleAuthenticationToken.txt"',
    'X_KEY = "../synthetic/credentials/ExampleAuthenticationToken.txt"',
    'X_KEY = "~/synthetic/credentials/ExampleAuthenticationToken.txt"',
    'X_KEY = "C:\\synthetic\\credentials\\ExampleAuthenticationToken.txt"',
    'X_KEY = "config/secrets/ExampleAuthenticationToken.json"',
    'X_KEY=synthetic/credentials/ExampleAuthenticationToken.txt',
  ];
  assert.deepEqual(scanFiles([{ path: 'scripts/example.txt', content: Buffer.from(values.join('\n')) }]), { blocked: false, findings: [] });
});

test('literal high-entropy values still block in Python, shell, Node and YAML assignments', () => {
  const lines = [
    `X_KEY = "${syntheticAlphabet}"`,
    `X_KEY='${syntheticAlphabet}'`,
    `X_KEY=${syntheticAlphabet}`,
    `const X_KEY = "${syntheticAlphabet}";`,
    `api_key: "${syntheticAlphabet}"`,
    `api_key: ${syntheticAlphabet}`,
    `api_key: "${syntheticAlphabet}+/${syntheticAlphabet}"`,
    'X_KEY = "process.env.SYNTHETIC_ONLY_KEY_NAME"',
    'X_KEY = "os.environ[SYNTHETIC_ONLY_KEY_NAME]"',
    "X_KEY = '$SYNTHETIC_ONLY_KEY_NAME'",
  ];
  const result = scanFiles([{ path: 'settings.txt', content: Buffer.from(lines.join('\n')) }]);
  assertRedacted(result, [syntheticAlphabet]);
  assert.deepEqual(result, { blocked: true, findings: lines.map((_, index) => ({ rule: 'high-entropy-assignment', path: 'settings.txt', line: index + 1 })) });
});

// TLS-18, TLS-19 and TLS-23 own their transports. Exercise their shared preflight
// contract here without implementing those cards' upload routes.
for (const caller of ['import', 'proposal', 'run output']) test(`${caller} preflight blocks the whole batch before injected fetch`, async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(String(init?.body));
    return Response.json({ data: {} });
  };
  const send = async (files: readonly ScanFile[]) => {
    const result = scanFiles(files);
    if (result.blocked) return result;
    await fetcher('https://example.test', {
      method: 'POST', body: JSON.stringify({ files: files.map(({ path, content }) => ({ path, content: content.toString('base64') })) }),
    });
    return result;
  };
  const clean = { path: 'SKILL.md', content: Buffer.from('A clean skill, proposal or run result.\n') };
  for (const { id } of SECRET_RULES) {
    assert.equal(typeof samples[id], 'string', `Missing synthetic sample for rule ${id}.`);
    const result = await send([clean, { path: 'references/example.md', content: Buffer.from(samples[id]) }]);
    assertRedacted(result, [samples[id]]);
    assert.equal(result.blocked, true, `The ${id} sample must block the batch.`);
    assert.equal(result.findings.some(finding => finding.rule === id), true, `The ${id} rule must block its sample.`);
    assert.equal(requests.length, 0);
  }
  const filename = { path: `${maddotsToken}.txt`, content: Buffer.from('clean') };
  assert.equal((await send([clean, filename])).blocked, true);
  assert.equal((await send([clean, { path: 'large.bin', content: Buffer.alloc(1024 * 1024 + 1) }])).blocked, true);
  assert.equal(requests.length, 0);
  assert.equal((await send([clean])).blocked, false);
  assert.equal(requests.length, 1, 'The clean positive control must reach the same injected fetch.');
  assert.ok(requests[0].includes(clean.content.toString('base64')));
});

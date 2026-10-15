import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { SKILL_LIMITS } from '../src/shared/skill-limits.js';
import { RELEASE_BUILD_KEYS } from '../src/build-keys.js';
import { HelperError } from '../src/config.js';
import { RELEASE } from '../src/release-identity.js';
import { BuildVerifier, signedBuildString, type BuildPublicKey, type PlanItem, type SignedBuild, type VerificationEntry } from '../src/verify.js';

function signer() {
  const pair = generateKeyPairSync('ed25519');
  const bytes = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const key: BuildPublicKey = { keyId: createHash('sha256').update(bytes).digest('hex').slice(0, 16), publicKey: bytes.toString('base64') };
  return { ...pair, key };
}
const signing = signer();
const otherSigning = signer();
const verifier = new BuildVerifier({ keys: [signing.key], env: {} });
function file(path = 'SKILL.md', text: string | Buffer = '---\nname: example\ndescription: Synthetic verification fixture\n---\nRead this skill.\n', mode: '100644' | '100755' = '100644') {
  const content = Buffer.from(text);
  return { path, mode, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64') };
}
function signed(changes: Partial<SignedBuild> = {}, signerKey = signing): SignedBuild {
  const files = changes.files ?? [file()];
  const build: SignedBuild = { format: 1, keyId: signerKey.key.keyId, skillId: 'skill-example', version: 2, settingsRevision: 5,
    level: 'workspace', workspaceId: 'workspace-a', boardId: null, target: 'folder', name: 'example',
    hasCode: false, draft: false, files, report: { renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: [] },
    digest: treeDigest(files.map(entry => ({ path: entry.path, mode: entry.mode, content: Buffer.from(entry.content, 'base64') }))), signature: '', ...changes };
  build.signature = sign(null, Buffer.from(signedBuildString(build)), signerKey.privateKey).toString('base64');
  return build;
}
function plan(build = signed(), changes: Partial<PlanItem> = {}): PlanItem {
  return { itemId: 'item-example', kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name,
    level: build.level, workspaceId: build.workspaceId, workspaceIds: [build.workspaceId], boardIds: build.boardId ? [build.boardId] : [],
    target: build.target, route: 'agents-folder', fromVersion: null, version: build.version, settingsRevision: build.settingsRevision,
    digest: build.digest, hasCode: build.hasCode, draft: build.draft, dependencyOf: null, missingDependencies: [], forAgentIds: [],
    state: 'approved', answer: 'update', reason: null, restartHints: [], ...changes };
}
function entry(build = signed(), changes: Partial<VerificationEntry> = {}): VerificationEntry {
  return { skillId: build.skillId, target: build.target, name: build.name, version: build.version,
    settingsRevision: build.settingsRevision, digest: build.digest, previous: null, ...changes };
}
function error(code: string) { return (value: unknown) => value instanceof HelperError && value.code === code; }

test('canonical signed bytes have the exact v1 order and no final newline', () => {
  const build = signed();
  assert.equal(signedBuildString(build), `maddots-ai-build-v1\nkey=${signing.key.keyId}\nskill=skill-example\nversion=2\nsettings=5\ndigest=${build.digest}\nlevel=workspace\nworkspace=workspace-a\ntarget=folder`);
  const alternative = { ...build, signature: sign(null, Buffer.from(signedBuildString(build) + '\n'), signing.privateKey).toString('base64') };
  assert.throws(() => verifier.verifySignature(alternative), error('BUILD_SIGNATURE_INVALID'));
});

test('valid Ed25519 builds use the shared tree digest and return independent bytes and metadata', () => {
  const build = signed({ files: [file('references/z.txt', 'z'), file(), file('references/a.txt', 'a')] });
  const result = verifier.verify(build, plan(build), { target: 'folder' });
  assert.equal(result.hasCode, false);
  assert.equal(treeDigest(result.files), build.digest);
  assert.notEqual(result.build, build);
  assert.notEqual(result.build.files, build.files);
  assert.notEqual(result.build.report.unsetSettings, build.report.unsetSettings);
  build.files[0].content = '';
  assert.equal(result.files[0].content.toString(), 'z');
  assert.notEqual(result.build.files[0].content, '');
  verifier.verifySignature({ ...result.build, signature: result.build.signature });
});

test('source checkout has no default trust roots; injected keys and rotation pin exact public bytes', () => {
  if (!RELEASE) assert.deepEqual(RELEASE_BUILD_KEYS, []);
  const build = signed();
  assert.throws(() => new BuildVerifier({ keys: [], env: {} }).verifySignature(build), error('BUILD_KEY_UNKNOWN'));
  assert.throws(() => new BuildVerifier({ keys: [otherSigning.key] }).verifySignature(build), error('BUILD_KEY_UNKNOWN'));
  const rotation = new BuildVerifier({ keys: [otherSigning.key, signing.key] });
  rotation.verifySignature(build);
  rotation.verifySignature(signed({}, otherSigning));
  const forgedKey = { ...otherSigning.key, keyId: signing.key.keyId };
  assert.throws(() => new BuildVerifier({ keys: [forgedKey] }), error('BUILD_KEY_INVALID'));
  assert.throws(() => new BuildVerifier({ keys: [signing.key, signing.key] }), error('BUILD_KEY_INVALID'));
});

test('DEV raw keys work only in source mode and release ignores even malformed overrides', () => {
  const env = { MADDOTS_AI_DEV_BUILD_KEYS: JSON.stringify([signing.key.publicKey]) };
  if (!RELEASE) new BuildVerifier({ env }).verifySignature(signed());
  assert.throws(() => new BuildVerifier({ release: true, env }).verifySignature(signed()), error('BUILD_KEY_UNKNOWN'));
  assert.doesNotThrow(() => new BuildVerifier({ release: true, env: { MADDOTS_AI_DEV_BUILD_KEYS: 'malformed' } }));
  if (!RELEASE) {
    for (const value of ['malformed', '{}', '[null]', JSON.stringify([signing.key.publicKey.slice(0, -1)]), JSON.stringify(['A'.repeat(44)]),
      JSON.stringify([signing.key.publicKey, signing.key.publicKey])]) {
      assert.throws(() => new BuildVerifier({ env: { MADDOTS_AI_DEV_BUILD_KEYS: value } }), error('BUILD_KEY_INVALID'));
    }
  }
});

test('every signed field is authenticated and multiline scalar injection fails closed', () => {
  const build = signed();
  const cases: Partial<SignedBuild>[] = [{ skillId: 'other-skill' }, { version: 3 }, { settingsRevision: 6 }, { digest: 'f'.repeat(64) },
    { level: 'global' }, { workspaceId: 'workspace-b' }, { target: 'desktop-zip' }];
  for (const change of cases) assert.throws(() => verifier.verifySignature({ ...build, ...change }), error('BUILD_SIGNATURE_INVALID'));
  for (const change of [{ format: 2 }, { version: -1 }, { version: 0 }, { settingsRevision: -1 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { settingsRevision: 0.5 }, { workspaceId: 'workspace\ntarget=folder' }, { skillId: 'skill\u0000' }, { keyId: 'F'.repeat(16) }, { digest: 'F'.repeat(64) }]) {
    assert.throws(() => verifier.verifySignature({ ...build, ...change } as SignedBuild), error('BUILD_FIELDS_INVALID'));
  }
});

test('malformed, padded and wrong-key signatures are rejected', () => {
  const build = signed();
  const bad = [build.signature.slice(0, -2), build.signature + '\n', build.signature.replace(/=$/, 'A'), 'A'.repeat(88),
    Buffer.alloc(63).toString('base64'), sign(null, Buffer.from(signedBuildString(build)), otherSigning.privateKey).toString('base64')];
  for (const signature of bad) assert.throws(() => verifier.verifySignature({ ...build, signature }), error('BUILD_SIGNATURE_INVALID'));
});

test('file bytes, declared hashes, declared sizes and whole-tree digest are independently checked', () => {
  const build = signed();
  const modified = structuredClone(build);
  modified.files[0].content = Buffer.alloc(modified.files[0].size, 32).toString('base64');
  assert.throws(() => verifier.verifyCached(modified, build.digest), error('BUILD_FILE_DIGEST_INVALID'));
  modified.files[0].sha256 = createHash('sha256').update(Buffer.from(modified.files[0].content, 'base64')).digest('hex');
  assert.throws(() => verifier.verifyCached(modified, build.digest), error('BUILD_DIGEST_INVALID'));
  const sized = structuredClone(build); sized.files[0].size += 1;
  assert.throws(() => verifier.verifyCached(sized, build.digest), error('BUILD_SIZE_INVALID'));
  const wrongTree = signed({ digest: 'f'.repeat(64) });
  assert.throws(() => verifier.verifyCached(wrongTree, wrongTree.digest), error('BUILD_DIGEST_INVALID'));
  assert.throws(() => verifier.verifyCached(build, 'a'.repeat(64)), error('BUILD_DIGEST_INVALID'));
});

test('base64 content is canonical and bounded before decoding', () => {
  const build = signed({ files: [file('SKILL.md', 'a')] });
  for (const content of ['YQ', 'YR==', 'YQ==\n', 'YQ===', 'YQ--', 'AAAA']) {
    const malformed = structuredClone(build); malformed.files[0].content = content;
    assert.throws(() => verifier.verifyCached(malformed, malformed.digest), error('BUILD_CONTENT_INVALID'));
  }
  const empty = signed({ files: [file('empty.txt', '')] });
  assert.equal(verifier.verifyCached(empty, empty.digest).files[0].content.length, 0);
});

test('unsafe, non-NFC and local-metadata paths are refused before digest exclusions can hide them', () => {
  const paths = ['../escape', 'a/../escape', '/absolute', 'C:escape', 'bad\\file', 'a//b', './file', 'a/', 'a\u0000b', 'a\u0085b',
    'a\u2028b', 'e\u0301.txt', '\ud800.txt', '.maddots', '.maddots/skill.json', '.MaDdOtS/skill.json',
    'assets/.DS_Store', 'assets/.ds_store', 'é'.repeat(128), 'a/'.repeat(SKILL_LIMITS.pathDepth) + 'b'];
  for (const path of paths) {
    const build = signed(); build.files[0].path = path;
    assert.throws(() => verifier.verifyCached(build, build.digest), error('BUILD_PATH_INVALID'), JSON.stringify(path));
  }
});

test('duplicate paths and case-folded file/directory collisions cannot reach macOS staging', () => {
  for (const paths of [['SKILL.md', 'skill.md'], ['SS.txt', 'ß.txt'], ['scripts', 'SCRIPTS/run.txt'], ['foo', 'foo'], ['a/B', 'A/b/c']]) {
    const build = signed(); build.files = paths.map(path => file(path));
    assert.throws(() => verifier.verifyCached(build, build.digest), error('BUILD_PATH_COLLISION'));
  }
});

test('only regular file modes and exact wire objects are accepted', () => {
  const build = signed();
  for (const mode of ['120000', '040755', '100664', 100644]) {
    const malformed = structuredClone(build) as any; malformed.files[0].mode = mode;
    assert.throws(() => verifier.verifyCached(malformed, build.digest), error('BUILD_MODE_INVALID'));
  }
  for (const change of [(value: any) => { value.files[0].link = 'target'; }, (value: any) => { delete value.files[0].size; }]) {
    const malformed = structuredClone(build); change(malformed);
    assert.throws(() => verifier.verifyCached(malformed, build.digest), error('BUILD_FILE_INVALID'));
  }
  for (const value of [null, [], { ...build, extra: true }, { ...build, report: { ...build.report, extra: true } },
    { ...build, draft: 'false' }, { ...build, name: '../escape' }, { ...build, files: {} }]) {
    assert.throws(() => verifier.verifyCached(value, build.digest), HelperError);
  }
});

test('1 MiB per file, 10 MiB per build and 500 files are enforced', () => {
  const large = Buffer.alloc(SKILL_LIMITS.fileBytes);
  const exact = signed({ files: Array.from({ length: 10 }, (_, index) => file(`assets/${index}.bin`, large)) });
  assert.equal(verifier.verifyCached(exact, exact.digest).files.length, 10);
  const tooLarge = structuredClone(exact); tooLarge.files[0].size += 1;
  assert.throws(() => verifier.verifyCached(tooLarge, exact.digest), error('BUILD_TOO_LARGE'));
  const overTotal = structuredClone(exact); overTotal.files.push(file('extra', 'a'));
  assert.throws(() => verifier.verifyCached(overTotal, exact.digest), error('BUILD_TOO_LARGE'));
  const tooMany = signed(); tooMany.files = Array.from({ length: 501 }, (_, index) => file(`a${index}`, ''));
  assert.throws(() => verifier.verifyCached(tooMany, tooMany.digest), error('BUILD_INVALID'));
});

test('revoked digests cannot be delivered, cached, or restored under another metadata identity', () => {
  const build = signed();
  const revoked = [{ skillId: build.skillId, digest: build.digest }];
  assert.throws(() => verifier.verify(build, plan(build), { target: 'folder', revoked }), error('BUILD_REVOKED'));
  assert.throws(() => verifier.verifyCached(build, build.digest, revoked), error('BUILD_REVOKED'));
  assert.throws(() => verifier.verifyCached(build, build.digest, [{ ...revoked[0], skillId: 'other-skill' }]), error('BUILD_REVOKED'));
});

test('signed fields and delivery metadata must match the plan and the concrete route target', () => {
  const build = signed();
  for (const change of [{ skillId: 'other-skill' }, { version: 3 }, { settingsRevision: 6 }, { level: 'global' as const },
    { workspaceId: 'workspace-b' }, { target: 'claude-plugin' as const }, { name: 'other-name' }, { draft: true }, { workspaceIds: [] }]) {
    assert.throws(() => verifier.verify(build, plan(build, change), { target: 'folder' }), error('BUILD_PLAN_MISMATCH'));
  }
  assert.throws(() => verifier.verify(build, plan(build), { target: 'desktop-zip' }), error('BUILD_PLAN_MISMATCH'));
  const board = signed({ level: 'board', boardId: 'board-a' });
  assert.throws(() => verifier.verify(board, plan(board, { boardIds: ['board-b'] }), { target: 'folder' }), error('BUILD_PLAN_MISMATCH'));
  verifier.verify(board, plan(board), { target: 'folder' });
});

test('rollback ordering is lexicographic and permits advancing shared settings from workspace to board', () => {
  const old = signed({ version: 4, settingsRevision: 7 });
  for (const build of [signed({ version: 5, settingsRevision: 0 }), signed({ version: 4, settingsRevision: 8, boardId: 'board-a' })]) {
    verifier.verify(build, plan(build), { target: 'folder', entry: entry(old) });
  }
  for (const build of [signed({ version: 3, settingsRevision: 999 }), signed({ version: 4, settingsRevision: 6 })]) {
    assert.throws(() => verifier.verify(build, plan(build), { target: 'folder', entry: entry(old) }), error('BUILD_ROLLBACK'));
  }
});

test('identical re-delivery succeeds but an equal version/settings replay with different bytes fails', () => {
  const build = signed();
  verifier.verify(build, plan(build, { kind: 'local_newer', answer: 'replace' }), { target: 'folder', entry: entry(build) });
  const altered = signed({ files: [file('SKILL.md', 'Other content.')] });
  assert.throws(() => verifier.verify(altered, plan(altered), { target: 'folder', entry: entry(build) }), error('BUILD_ROLLBACK'));
  assert.throws(() => verifier.verify(build, plan(build), { target: 'folder', entry: entry(build, { skillId: 'other-skill' }) }), error('BUILD_ENTRY_MISMATCH'));
});

test('forced restore permits only the exact previous build, and no other forced install passes', () => {
  const previous = signed({ version: 1, settingsRevision: 0 });
  const current = signed();
  const currentEntry = entry(current, { previous: { version: previous.version, settingsRevision: previous.settingsRevision, digest: previous.digest } });
  const restore = plan(previous, { kind: 'forced_restore', state: 'forced', reason: 'security_fix' });
  verifier.verify(previous, restore, { target: 'folder', entry: currentEntry });
  assert.throws(() => verifier.verify(previous, restore, { target: 'folder' }), error('BUILD_RESTORE_INVALID'));
  assert.throws(() => verifier.verify(previous, restore, { target: 'folder', entry: entry(current) }), error('BUILD_RESTORE_INVALID'));
  const wrongVersion = signed({ version: 1, settingsRevision: 1 });
  assert.throws(() => verifier.verify(wrongVersion, plan(wrongVersion, { kind: 'forced_restore', state: 'forced' }),
    { target: 'folder', entry: currentEntry }), error('BUILD_RESTORE_INVALID'));
  for (const change of [{ state: 'forced' as const }, { kind: 'forced_remove' as const, state: 'forced' as const }]) {
    assert.throws(() => verifier.verify(current, plan(current, change), { target: 'folder' }), error('BUILD_ACTION_INVALID'));
  }
  assert.throws(() => verifier.verify(previous, restore, { target: 'folder', entry: currentEntry,
    revoked: [{ skillId: previous.skillId, digest: previous.digest }] }), error('BUILD_REVOKED'));
});

test('has-code detection catches all mandatory indicators independently of server flags', () => {
  const samples = [
    file('scripts/read.txt', 'Plain text'), file('nested/SCRIPTS/read.txt', 'Plain text'), file('executable', '', '100755'),
    file('SKILL.md', '---\nallowed-tools: Bash\n---\nRead.'), file('SKILL.md', '---\n"allowed-\\u0074ools": Bash\n---\nRead.'),
    file('SKILL.md', '\ufeff---\r\n{ name: example, allowed-tools: [Bash] }\r\n---\r\nRead.'),
    file('SKILL.md', 'Read.\n!echo example'), file('references/example.md', '\r\t!echo example'),
    file('SKILL.md', 'Read !`echo example`'), file('SKILL.md', 'Read !`unterminated'),
    file('SKILL.md', 'Read!`unterminated'),
    file('references/example.md', '---\nallowed-tools: Read\n---\nPlain.'),
  ];
  for (const input of samples) {
    const build = signed({ files: [input] });
    assert.equal(verifier.verifyCached(build, build.digest).hasCode, true, input.path + ': ' + Buffer.from(input.content, 'base64').toString());
  }
  const declared = signed({ hasCode: true });
  assert.equal(verifier.verifyCached(declared, declared.digest).hasCode, true);
  const plain = signed();
  assert.equal(verifier.verify(plain, plan(plain, { hasCode: true }), { target: 'folder' }).hasCode, true);
});

test('case-insensitive instruction paths require Allow even when signed build and plan flags are false', () => {
  for (const path of ['skill.md', 'Skill.md', 'references/example.MD', 'References/example.md', 'ReFeReNcEs/Nested/Example.Md']) {
    for (const content of ['!echo example', 'Read !`id`', '---\nallowed-tools: Bash\n---\nRead.']) {
      const build = signed({ files: [file(path, content)], hasCode: false });
      const item = plan(build, { hasCode: false });
      const cached = verifier.verifyCached(build, build.digest);
      const delivered = verifier.verify(build, item, { target: 'folder' });
      assert.equal(cached.hasCode, true, `${path}: ${content}`);
      assert.equal(delivered.hasCode, true, `${path}: ${content}`);
      assert.equal(cached.files[0].path, path);
      assert.equal(delivered.build.files[0].path, path);
      assert.equal(treeDigest(delivered.files), build.digest);
    }
    const plain = signed({ files: [file(path, 'Plain instructions.')] });
    assert.equal(verifier.verifyCached(plain, plain.digest).hasCode, false, path);
  }
});

test('helper keeps its conservative allowed-tools guard for malformed and unclosed frontmatter', () => {
  for (const content of [
    '---\nallowed-tools: Bash\nallowed-tools: Read\n---\nRead.',
    '---\n"allowed-\\u0074ools": Bash\nRead.',
    '---\rallowed-tools: Bash\r---\rRead.',
  ]) {
    const build = signed({files: [file('references/example.md', content)]});
    assert.equal(verifier.verifyCached(build, build.digest).hasCode, true);
  }
});

test('plain skill frontmatter and ordinary text do not become code accidentally', () => {
  const build = signed({ files: [file('SKILL.md', '---\nname: example\ndescription: Plain skill\n---\nThe allowed-tools key is optional.\n')] });
  assert.equal(verifier.verifyCached(build, build.digest).hasCode, false);
});

test('binary asset newline and carriage-return exclamation bytes are not commands', () => {
  for (const separator of [0x0a, 0x0d]) {
    const build = signed({ files: [file(), file('assets/logo.png', Buffer.from([0x89, 0x50, 0x00, separator, 0x21, 0xff]))] });
    assert.equal(verifier.verifyCached(build, build.digest).hasCode, false, `binary separator ${separator}`);
  }
});

test('command markers in noninstruction and non-Markdown assets do not become code', () => {
  for (const path of ['assets/notes.txt', 'assets/notes.md', 'references/notes.txt', 'README.md']) {
    for (const content of ['Read !`echo example`', 'Read !`unterminated', 'One\r\nTwo\r!three\nFour']) {
      const build = signed({ files: [file(), file(path, content)] });
      assert.equal(verifier.verifyCached(build, build.digest).hasCode, false, `${path}: ${JSON.stringify(content)}`);
    }
  }
});

test('Markdown image lines in instruction files do not become code', () => {
  for (const path of ['SKILL.md', 'references/example.md', 'references/nested/example.md']) {
    const build = signed({ files: [file(path, 'Read.\n![Image](assets/logo.png)\r\n  ![Another image](assets/another.png)\n')] });
    assert.equal(verifier.verifyCached(build, build.digest).hasCode, false, path);
  }
});

test('allowed-tools text in frontmatter values is not a declaration', () => {
  for (const path of ['SKILL.md', 'references/example.md', 'references/nested/example.md']) {
    for (const frontmatter of [
      'description: Works without allowed-tools',
      'description: "Works without allowed-tools: Bash"',
      'description: "Works without allowed-\\u0074ools"',
      'description: |\n  allowed-tools: Bash',
      'description: >\n  allowed-tools: Bash',
      'description: \'Works without\n  allowed-tools: Bash\'',
      'metadata:\n  allowed-tools: Bash',
      'metadata:\n  ? allowed-tools\n  : Bash',
      'metadata:\n  &tools allowed-tools: Bash',
      '{metadata: {? allowed-tools: Bash}}',
      'description: "? allowed-tools: Bash"',
      'description: "&tools allowed-tools: Bash"',
      '# allowed-tools: Bash\ndescription: Plain skill',
      '{"description": "Works without allowed-tools: Bash"}',
      '{description: "allowed-tools: Bash", metadata: {allowed-tools: Bash}}',
    ]) {
      const build = signed({ files: [file(path, `---\n${frontmatter}\n---\nRead.`)] });
      assert.equal(verifier.verifyCached(build, build.digest).hasCode, false, `${path}: ${frontmatter}`);
    }
  }
});

test('real top-level allowed-tools keys count only in instruction Markdown frontmatter', () => {
  for (const frontmatter of [
    'allowed-tools: Bash',
    '"allowed-tools": Bash',
    "'allowed-tools': Bash",
    '"allowed-\\u0074ools": Bash',
    '{"description":"Plain skill","allowed-tools":["Bash"]}',
    '{name: example, allowed-tools: [Bash]}',
    '? allowed-tools\n: Bash',
    '&tools allowed-tools: Bash',
    '{? allowed-tools: Bash}',
    '? &tools "allowed-\\u0074ools"\n: Bash',
    '{? &tools "allowed-tools": Bash}',
  ]) {
    for (const path of ['SKILL.md', 'references/example.md', 'references/nested/example.md']) {
      const build = signed({ files: [file(path, `---\n${frontmatter}\n---\nRead.`)] });
      assert.equal(verifier.verifyCached(build, build.digest).hasCode, true, `${path}: ${frontmatter}`);
    }
    for (const path of ['assets/notes.txt', 'assets/notes.md', 'references/notes.txt', 'README.md']) {
      const build = signed({ files: [file(), file(path, `---\n${frontmatter}\n---\nRead.`)] });
      assert.equal(verifier.verifyCached(build, build.digest).hasCode, false, `${path}: ${frontmatter}`);
    }
  }
});

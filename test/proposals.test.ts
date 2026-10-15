import assert from 'node:assert/strict';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { SKILL_LIMITS } from '../src/shared/skill-limits.js';
import { ApiClient } from '../src/api.js';
import { HelperError } from '../src/config.js';
import { parseSendProposalInstruction, reverseProposalFiles, sendProposal, type SendProposalInstruction } from '../src/proposals.js';
import type { SafeBuildFile } from '../src/safe-fs.js';
import type { PlanItem } from '../src/verify.js';

const syntheticSecret = ['pm', 'run', 'SYNTHETIC_TEST_ONLY_'.repeat(2)].join('_');
const itemId = 'a'.repeat(64);
function instruction(changes: Partial<SendProposalInstruction> = {}): SendProposalInstruction {
  return {type: 'send_proposal', itemId, intent: 'proposal', baseVersion: 1, placeholders: [], nameMap: [], modelLine: null, ...changes};
}
function item(changes: Partial<PlanItem> = {}): PlanItem {
  return {itemId, kind: 'local_newer', skillId: 'skill-test', name: 'workspace-example', sourceName: 'example', level: 'workspace',
    workspaceId: 'workspace-test', workspaceIds: ['workspace-test'], boardIds: [], target: 'folder', route: 'agents-folder',
    fromVersion: 1, version: 2, settingsRevision: 1, digest: 'b'.repeat(64), hasCode: false, draft: false, dependencyOf: null,
    missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'send_proposal', reason: null, restartHints: [], ...changes};
}
function file(content = 'A locally improved guide.\n', path = 'SKILL.md', mode: SafeBuildFile['mode'] = '100644'): SafeBuildFile {
  return {path, mode, content: Buffer.from(content)};
}
function fixture(files: SafeBuildFile[] = [file()]) {
  const calls: {url: string; method: string | undefined; body: Record<string, any>}[] = [];
  const client = new ApiClient(new URL('https://ai.example.test'), async (url, init) => {
    calls.push({url: String(url), method: init?.method, body: JSON.parse(String(init?.body))});
    return new Response(JSON.stringify({data: {proposalId: 'proposal-test'}}), {status: 201, headers: {'content-type': 'application/json'}});
  });
  const options = {client, files, localDigest: treeDigest(files), item: item(), instruction: instruction()};
  return {calls, options};
}
function uploadedText(body: Record<string, any>, path = 'SKILL.md'): string {
  return Buffer.from(body.files.find((value: {path: string}) => value.path === path).content, 'base64').toString();
}

test('approved proposal reverses names, references, model line and metadata before its only upload', async () => {
  const text = ['---', 'name: workspace-example', 'description: A local improvement', 'metadata:', '  author: Local editor',
    '  maddots_skill_id: skill-test', '  "maddots_version": "1"', "  'maddots_settings_revision': '1'", 'license: MIT', '---',
    'Use [workspace-review](../workspace-review/SKILL.md) at https://workspace.example.test.',
    'An unrelated [review](../other/SKILL.md) stays a link.', 'Works best with: Model A', 'Works best with: User recommendation', ''].join('\r\n');
  const f = fixture([file(text)]);
  f.options.instruction = instruction({nameMap: [{sourceName: 'review', deliveredName: 'workspace-review'}],
    placeholders: [{name: 'base_url', value: 'https://workspace.example.test'}], modelLine: 'Works best with: Model A'});
  await sendProposal(f.options);
  assert.equal(f.calls.length, 1);
  const {body, url, method} = f.calls[0];
  assert.equal(url, 'https://ai.example.test/api/helper/proposals'); assert.equal(method, 'POST');
  assert.deepEqual(Object.keys(body).sort(), ['baseVersion', 'files', 'intent', 'itemId', 'localDigest', 'skillId']);
  assert.deepEqual(Object.keys(body.files[0]).sort(), ['content', 'mode', 'path']);
  assert.equal(body.baseVersion, 1); assert.equal(body.localDigest, treeDigest(f.options.files));
  assert.equal(body.skillId, 'skill-test'); assert.equal(body.itemId, itemId); assert.equal(body.intent, 'proposal');
  assert.equal(uploadedText(body), ['---', 'name: example', 'description: A local improvement', 'metadata:', '  author: Local editor',
    'license: MIT', '---', 'Use {{skill:review}} at {{base_url}}.', 'An unrelated [review](../other/SKILL.md) stays a link.',
    'Works best with: User recommendation', ''].join('\r\n'));
  assert.equal(JSON.stringify(body).includes('https://workspace.example.test'), false);
  assert.equal(f.options.files[0].content.toString(), text, 'Proposal reversal never changes the managed local copy.');
});

test('longest matching settings are substituted once without rewriting generated placeholders', async () => {
  const f = fixture([file('https://host.example.test host.example.test host ${host}\n')]);
  f.options.instruction = instruction({placeholders: [{name: 'short', value: 'host'}, {name: 'host_name', value: 'host.example.test'},
    {name: 'host_url', value: 'https://host.example.test'}]});
  await sendProposal(f.options);
  assert.equal(uploadedText(f.calls[0].body), '{{host_url}} {{host_name}} {{short}} ${{{short}}}\n');
});

test('longer settings win overlapping original matches even when the shorter value starts earlier', async () => {
  const f = fixture([file('MadDots AI helper and MadDots. {{long_name}}\n')]);
  f.options.instruction = instruction({placeholders: [{name: 'short_name', value: 'MadDots'}, {name: 'long_name', value: 'Dots AI helper'}]});
  await sendProposal(f.options);
  assert.equal(uploadedText(f.calls[0].body), 'Mad{{long_name}} and {{short_name}}. {{long_name}}\n');
});

test('setting values under three characters stay unchanged, including two Unicode characters', () => {
  const reversed = reverseProposalFiles([file('A AB 😀😀 😀😀😀 abc')], instruction({placeholders: [
    {name: 'one', value: 'A'}, {name: 'two', value: 'AB'}, {name: 'two_unicode', value: '😀😀'},
    {name: 'three_unicode', value: '😀😀😀'}, {name: 'three', value: 'abc'},
  ]}), 'folder');
  assert.equal(reversed[0].content.toString(), 'A AB 😀😀 {{three_unicode}} {{three}}');
});

test('pre-existing placeholders survive values that equal part of a setting or skill name', async () => {
  const f = fixture([file('{{brand}} {{skill:brand-review}} brand\n')]);
  f.options.instruction = instruction({placeholders: [{name: 'company', value: 'brand'}]});
  await sendProposal(f.options);
  assert.equal(uploadedText(f.calls[0].body), '{{brand}} {{skill:brand-review}} {{company}}\n');
});

test('known setting secrets are removed before scanning every outgoing file type', async () => {
  const f = fixture([file('---\nname: workspace-example\ndescription: ' + syntheticSecret + '\n---\nLocal change.\n'),
    file('value = "' + syntheticSecret + '"\n', 'scripts/example.ts', '100755'), file(syntheticSecret, 'references/context.md')]);
  f.options.instruction = instruction({placeholders: [{name: 'credential', value: syntheticSecret}]});
  await sendProposal(f.options);
  assert.equal(f.calls.length, 1);
  for (const value of f.calls[0].body.files) assert.equal(Buffer.from(value.content, 'base64').includes(Buffer.from(syntheticSecret)), false);
  assert.equal(uploadedText(f.calls[0].body, 'scripts/example.ts'), 'value = "{{credential}}"\n');
  assert.equal(f.calls[0].body.files[1].mode, '100755');
});

test('manifest defaults and type scalars remain byte-identical when they equal placeholder values', async () => {
  const manifest = ['category: development', 'settings:', '  label:', '    type: text', '    default: Default label',
    '  quoted:', '    type: text', '    "default": "Default label"', '  other:', '    type: text',
    "    default: 'Keep this'", '  tiny:', '    type: text', '    default: ok', ''].join('\r\n');
  const f = fixture([file('Use Default label.'), file(manifest, 'maddots.yaml')]);
  f.options.instruction = instruction({placeholders: [{name: 'label', value: 'Default label'}, {name: 'tiny', value: 'ok'}, {name: 'kind', value: 'text'}]});
  await sendProposal(f.options);
  assert.equal(uploadedText(f.calls[0].body), 'Use {{label}}.');
  assert.equal(uploadedText(f.calls[0].body, 'maddots.yaml'), manifest);
  assert.equal(f.options.files[1].content.toString(), manifest);
});

test('manifest flow, block and wrapped scalars are preserved for the server base comparison', async () => {
  for (const manifest of ['settings: {label: {type: text, default: Default label}}\n',
    'settings:\n  label:\n    type: text\n    default: |\n      Default label\n',
    'settings:\n  label:\n    type: text\n    default: "Default label\n      continued"\n']) {
    const f = fixture([file(), file(manifest, 'maddots.yaml')]);
    f.options.instruction = instruction({placeholders: [{name: 'label', value: 'Default label'}]});
    await sendProposal(f.options); assert.equal(f.calls.length, 1);
    assert.equal(uploadedText(f.calls[0].body, 'maddots.yaml'), manifest);
  }
});

test('binary and malformed UTF-8 retain every byte outside exact settings replacements', async () => {
  const binary = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from(syntheticSecret), Buffer.from([254, 1])]);
  const f = fixture([file(), {path: 'assets/blob.bin', mode: '100644', content: binary},
    {path: 'references/odd.md', mode: '100644', content: binary}]);
  f.options.instruction = instruction({placeholders: [{name: 'credential', value: syntheticSecret}]});
  await sendProposal(f.options);
  const expected = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from('{{credential}}'), Buffer.from([254, 1])]);
  for (const value of f.calls[0].body.files.slice(1)) assert.deepEqual(Buffer.from(value.content, 'base64'), expected);
  assert.deepEqual(f.options.files[1].content, binary);
});

test('remaining content secrets, binary secrets and filename secrets never reach fetch or error messages', async () => {
  for (const files of [[file(syntheticSecret)], [file(), file(syntheticSecret, 'assets/data.bin')],
    [file(), file('clean', 'references/' + syntheticSecret + '.md')]]) {
    const f = fixture(files);
    await assert.rejects(sendProposal(f.options), (error: unknown) => {
      assert.ok(error instanceof HelperError); assert.equal(error.code, 'PROPOSAL_SCAN_BLOCKED');
      assert.equal(String(error).includes(syntheticSecret), false); assert.equal(JSON.stringify(error).includes(syntheticSecret), false);
      return true;
    });
    assert.equal(f.calls.length, 0);
  }
});

test('settings in filenames are refused without exposing the filename', async () => {
  const f = fixture([file(), file('guide', 'references/private-workspace-host.md')]);
  f.options.instruction = instruction({placeholders: [{name: 'host', value: 'private-workspace-host'}]});
  await assert.rejects(sendProposal(f.options), (error: unknown) => {
    assert.ok(error instanceof HelperError); assert.equal(error.code, 'PROPOSAL_PATH_SETTING');
    assert.equal(String(error).includes('private-workspace-host'), false); return true;
  });
  assert.equal(f.calls.length, 0);
});

test('only a matching approved local-newer answer can cause an upload', async () => {
  const changes: Partial<PlanItem>[] = [{state: 'asking'}, {state: 'later'}, {state: 'kept_local'}, {state: 'failed'},
    {answer: null}, {answer: 'replace'}, {answer: 'keep_local'}, {answer: 'publish'}, {kind: 'update'},
    {itemId: 'c'.repeat(64)}, {fromVersion: 2}, {forAgentIds: ['agent-test']}];
  for (const change of changes) {
    const f = fixture(); f.options.item = item(change);
    await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_NOT_APPROVED'}); assert.equal(f.calls.length, 0);
  }
});

test('publish intent is uploaded only for the matching publish answer and creates no local publish action', async () => {
  const f = fixture(); f.options.instruction = instruction({intent: 'publish'});
  await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_NOT_APPROVED'}); assert.equal(f.calls.length, 0);
  f.options.item = item({answer: 'publish'}); await sendProposal(f.options);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.intent, 'publish');
});

test('a changed file snapshot or stale digest is refused before upload', async () => {
  const f = fixture(); f.options.files[0].content = Buffer.from('Changed again after consent.');
  await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_LOCAL_CHANGED'}); assert.equal(f.calls.length, 0);
  f.options.localDigest = 'd'.repeat(64);
  await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_LOCAL_CHANGED'}); assert.equal(f.calls.length, 0);
});

test('instruction validation refuses malformed fields without reflecting their contents', () => {
  const invalid = [null, {}, {...instruction(), arbitrary: syntheticSecret}, instruction({baseVersion: 0}),
    instruction({modelLine: 'Works best with: Model\n' + syntheticSecret}),
    instruction({placeholders: [{name: '../secret', value: syntheticSecret}]}),
    instruction({placeholders: [{name: 'host', value: 'abc'}, {name: 'host', value: 'def'}]}),
    instruction({nameMap: [{sourceName: 'one', deliveredName: 'same'}, {sourceName: 'two', deliveredName: 'same'}]}),
    instruction({nameMap: [{sourceName: '../secret', deliveredName: 'example'}]})];
  for (const value of invalid) assert.throws(() => parseSendProposalInstruction(value), (error: unknown) => {
    assert.ok(error instanceof HelperError); assert.equal(error.code, 'PROPOSAL_INSTRUCTION_INVALID');
    assert.equal(String(error).includes(syntheticSecret), false); return true;
  });
  const source = instruction({placeholders: [{name: 'host', value: 'example.test'}]});
  const parsed = parseSendProposalInstruction(source); source.placeholders[0].value = 'changed';
  assert.equal(parsed.placeholders[0].value, 'example.test');
});

test('canonical block and flow metadata drop only maddots keys and preserve prose lookalikes', () => {
  const text = '---\nname: example\nmetadata: {maddots_version: "1", author: "A, B", \'maddots_skill_id\': "skill", note: "maddots_version: keep"}\n---\n' +
    'metadata:\n  maddots_version: This is prose.\n';
  const result = reverseProposalFiles([file(text)], instruction(), 'folder')[0].content.toString();
  assert.equal(result, '---\nname: example\nmetadata: { author: "A, B", note: "maddots_version: keep"}\n---\nmetadata:\n  maddots_version: This is prose.\n');
  const only = reverseProposalFiles([file('---\nmetadata:\n  maddots_version: "1"\n---\nText\n')], instruction(), 'folder')[0];
  assert.equal(only.content.toString(), '---\nmetadata: {}\n---\nText\n');
});

test('unsupported metadata aliases and malformed SKILL.md text fail closed before fetch', async () => {
  for (const content of ['---\nmetadata: *local\n---\nText', '---\nmetadata: {author: *local}\n---\nText',
    '---\nmetadata:\n  <<: *local\n---\nText', '---\nmetadata:\n  "maddots\\x5fversion": "1"\n---\nText']) {
    const f = fixture([file(content)]);
    await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_METADATA_INVALID'}); assert.equal(f.calls.length, 0);
  }
  const f = fixture([{path: 'SKILL.md', mode: '100644', content: Buffer.from([255, 0, 1])}]);
  await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_CONTENT_INVALID'}); assert.equal(f.calls.length, 0);
});

test('Desktop references and exact model lines reverse only their renderer forms', () => {
  const spec = instruction({nameMap: [{sourceName: 'review', deliveredName: 'workspace-review'}], modelLine: 'Works best with: Model A'});
  const files = [file('`workspace-review` workspace-review `other`\nWorks best with: Model A \nWorks best with: Model A\n'),
    file('Works best with: Model A\n`workspace-review`', 'references/note.md'), file('`workspace-review`', 'scripts/run.sh')];
  const result = reverseProposalFiles(files, spec, 'desktop-zip');
  assert.equal(result[0].content.toString(), '{{skill:review}} workspace-review `other`\nWorks best with: Model A \n');
  assert.equal(result[1].content.toString(), 'Works best with: Model A\n{{skill:review}}');
  assert.equal(result[2].content.toString(), '`workspace-review`');
});

test('invalid paths, local metadata and expansions exceeding upload limits never reach fetch', async () => {
  for (const path of ['../secret.md', '/absolute.md', '.maddots/skill.json', 'nested/.maddots/skill.json', '.DS_Store']) {
    const f = fixture(); f.options.files = [file('clean', path)];
    await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_FILES_INVALID'}); assert.equal(f.calls.length, 0);
  }
  const f = fixture([file('abc'.repeat(Math.floor(SKILL_LIMITS.fileBytes / 3)))]);
  f.options.instruction = instruction({placeholders: [{name: 'a_very_long_setting_name', value: 'abc'}]});
  await assert.rejects(sendProposal(f.options), {code: 'PROPOSAL_FILES_INVALID'}); assert.equal(f.calls.length, 0);
});

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Adapter, ParsedResult, RunSpec } from '../adapter.js';

const exec = promisify(execFile);
const providerID = /^[a-z][a-z0-9_-]{0,63}$/u;
const modelID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u;
const variantID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const toolIDs = new Set(['read', 'glob', 'grep', 'list', 'edit', 'write', 'patch', 'apply_patch', 'multiedit', 'bash', 'skill', 'todowrite', 'todoread']);
const failed = (failureCode = 'tool_failed'): ParsedResult => ({ ok: false, text: '', failureCode });
type Row = Record<string, unknown> & { type: string };
type Part = Record<string, unknown> & { type: string; messageID: string; id: string; sessionID: string };

export interface OpenCodeOptions {
  /** Reserved trusted settings. Custom/hosted providers stay sync only until the core has their secret path. */
  providers?: Record<string, { baseURL: string }>;
}

export function openCodeRunPaths(runDir: string) {
  const root = join(runDir, 'config/xdg');
  return { config: join(root, 'config/opencode'), data: join(root, 'data'), cache: join(root, 'cache'),
    state: join(root, 'state'), database: join(root, 'data/opencode/opencode.db') };
}

/** Managed configuration wins after the inline overlay in pinned OpenCode v1. Never bypass it. */
export function openCodeManagedPaths(platform: NodeJS.Platform, username: string, programData = 'C:\\ProgramData'): string[] {
  const root = platform === 'darwin' ? '/Library/Application Support/opencode' : platform === 'win32' ? join(programData, 'opencode') : join('/', 'etc', 'opencode');
  return [join(root, 'opencode.json'), join(root, 'opencode.jsonc'), ...(platform === 'darwin' ? [
    join('/Library/Managed Preferences', username, 'ai.opencode.managed.plist'),
    '/Library/Managed Preferences/ai.opencode.managed.plist',
  ] : [])];
}

function managedConfigPresent(): boolean {
  try { return openCodeManagedPaths(process.platform, userInfo().username, process.env.ProgramData).some(path => existsSync(path)); }
  catch { return true; }
}

function personalConfigPresent(): boolean {
  // Pinned v1 always enumerates ~/.opencode, including dependency setup, even
  // when project discovery and external plugins are disabled. Do not read it.
  return existsSync(join(process.env.HOME ?? homedir(), '.opencode'));
}

function selection(input: Pick<RunSpec, 'provider' | 'model'>): { provider: string; model: string } | null {
  if (typeof input.model !== 'string' || !modelID.test(input.model)) return null;
  if (input.provider !== null) return typeof input.provider === 'string' && providerID.test(input.provider)
    ? { provider: input.provider, model: input.model } : null;
  const slash = input.model.indexOf('/');
  if (slash <= 0) return null;
  const provider = input.model.slice(0, slash), model = input.model.slice(slash + 1);
  return providerID.test(provider) && modelID.test(model) ? { provider, model } : null;
}

function rows(stdout: string, partial: boolean): Row[] {
  const lines = stdout.split('\n'), result: Row[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let row: unknown;
    try { row = JSON.parse(line); }
    catch (error) { if (partial && index === lines.length - 1) break; throw error; }
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof (row as Row).type !== 'string') throw new Error('Invalid OpenCode event.');
    result.push(row as Row);
  }
  return result;
}

function part(row: Row): Part {
  const value = row.part as Part | undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string' ||
    typeof value.messageID !== 'string' || !value.messageID || typeof value.id !== 'string' || !value.id ||
    typeof value.sessionID !== 'string' || value.sessionID !== row.sessionID) throw new Error('Invalid OpenCode part.');
  return value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function checkTools(events: Row[]): { mcpServers: string[]; browserTools: string[] } {
  const unknown = new Set<string>(), servers = new Set<string>();
  const inventory = (source: Record<string, unknown> | null) => {
    if (!source) return;
    for (const key of ['mcpServers', 'mcp_servers']) {
      if (!(key in source)) continue;
      const value = source[key];
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) servers.add(typeof entry === 'string' && entry ? entry :
          typeof object(entry)?.name === 'string' && object(entry)!.name ? String(object(entry)!.name) : 'reported-mcp-server');
      } else if (object(value)) {
        for (const name of Object.keys(value)) servers.add(name || 'reported-mcp-server');
      } else servers.add('reported-mcp-server');
    }
  };
  for (const row of events) {
    inventory(row);
    inventory(object(row.metadata));
    inventory(object(row.system));
    inventory(object(row.part));
    inventory(object(object(row.part)?.metadata));
    inventory(object(object(object(row.part)?.state)?.metadata));
    if (row.type !== 'tool_use') continue;
    const value = part(row);
    if (value.type !== 'tool' || typeof value.tool !== 'string' || !value.tool) throw new Error('Invalid OpenCode tool.');
    // Only built-ins enabled in the run config are accepted. Unknown plugin,
    // browser and MCP tools cause the core to stop, regardless of their names.
    if (!toolIDs.has(value.tool)) unknown.add(value.tool);
  }
  // Pinned v1 normally exposes tool use only. Fail closed if an inventory is
  // added, while config isolation and the process probe prove startup silence.
  return { mcpServers: [...servers], browserTools: [...unknown] };
}

export function inspectOpenCodeOutput(stdout: string, skill?: { skillName: string; skillMarker: string; skillsDir: string }): {
  sessionID: string | null; skillLoaded: boolean; skillMarkerSeen: boolean; mcpServers: string[]; browserTools: string[];
} {
  const empty = { sessionID: null, skillLoaded: false, skillMarkerSeen: false, mcpServers: [], browserTools: [] };
  try {
    const events = rows(stdout, false), check = checkTools(events);
    const sessions = new Set(events.map(row => row.sessionID).filter((value): value is string => typeof value === 'string' && !!value));
    if (sessions.size !== 1 || events.some(row => row.sessionID !== [...sessions][0])) return { ...empty, ...check };
    let skillLoaded = false, skillMarkerSeen = false;
    if (skill) for (const row of events) {
      if (row.type !== 'tool_use') continue;
      const value = part(row), state = object(value.state), input = object(state?.input), metadata = object(state?.metadata);
      if (value.tool !== 'skill' || state?.status !== 'completed' || input?.name !== skill.skillName ||
        metadata?.name !== skill.skillName || metadata.dir !== join(skill.skillsDir, skill.skillName)) continue;
      skillLoaded = true;
      if (typeof state.output === 'string' && state.output.includes(`<skill_content name="${skill.skillName}">`) &&
        skill.skillMarker && state.output.includes(skill.skillMarker)) skillMarkerSeen = true;
    }
    return { ...check, sessionID: [...sessions][0], skillLoaded, skillMarkerSeen };
  } catch { return empty; }
}

function endpoint(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'baseURL') ||
    typeof (value as { baseURL?: unknown }).baseURL !== 'string') throw new Error('adapter_refused');
  const raw = (value as { baseURL: string }).baseURL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('adapter_refused'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    /[\s{}]/u.test(raw) || raw.length > 2048) throw new Error('adapter_refused');
  return raw;
}

export function createOpenCodeAdapter(options: OpenCodeOptions = {}): Adapter {
  const providers = new Map<string, string>([['ollama', 'http://127.0.0.1:11434/v1'], ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ['openrouter', 'https://openrouter.ai/api/v1']]);
  for (const [id, value] of Object.entries(options.providers ?? {})) {
    if (!providerID.test(id) || providers.has(id) || id === 'openrouter') throw new Error('adapter_refused');
    providers.set(id, endpoint(value));
  }
  const adapter: Adapter = {
    info: { tool: 'opencode', harness: 'opencode', card: 'TLS-28', folderOnly: 'none', mcpLevel: 'servers-off',
      skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false },

    async identity(bin) {
      let home: string | undefined;
      try {
        if (!isAbsolute(bin) || !/^opencode(?:\.exe)?$/u.test(basename(bin)) || managedConfigPresent() || personalConfigPresent()) return { ok: false, version: null };
        const resolved = await realpath(bin);
        if (!/^opencode(?:\.exe)?$/u.test(basename(resolved))) return { ok: false, version: null };
        home = await mkdtemp(join(tmpdir(), 'mdai-opencode-identity-'));
        const options = { cwd: home, timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8' as const, shell: false as const,
          env: { HOME: process.env.HOME ?? homedir(), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
            XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TERM: 'dumb', NO_COLOR: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_PURE: '1' } };
        const { stdout, stderr } = await exec(resolved, ['--version'], options);
        // v2 has a different config contract. A major upgrade needs acceptance.
        const match = /^(1\.\d+\.\d+)$/u.exec(stdout.trim());
        if (!match || stderr.trim()) return { ok: false, version: null };
        // The version is bare, so also verify the expected harness and controls.
        const help = await exec(resolved, ['run', '--help'], options);
        const helpText = help.stdout || help.stderr;
        return /^opencode run \[message\.\.\]/mu.test(helpText) &&
          ['--pure', '--format', '--auto', '--dir', '--variant'].every(flag => helpText.includes(flag))
          ? { ok: true, version: match[1] } : { ok: false, version: null };
      } catch { return { ok: false, version: null }; }
      finally { if (home) await rm(home, { recursive: true, force: true }); }
    },

    supports(input) {
      if (input.access !== 'full_access') return { ok: false, reason: 'OpenCode Folder only is unavailable: shell and file confinement and the R-02 no-shell decision have not been accepted.' };
      const selected = selection(input);
      if (!selected) return { ok: false, reason: 'Select an explicit Ollama or LM Studio provider and model.' };
      if (!['ollama', 'lmstudio'].includes(selected.provider)) return { ok: false,
        reason: 'Sync only: hosted and custom OpenCode providers have no supported core secret path. Isolated XDG configuration is accepted only for local Ollama and LM Studio without sign-in.' };
      if (input.effort !== null && (typeof input.effort !== 'string' || !variantID.test(input.effort))) return { ok: false, reason: 'Invalid OpenCode reasoning variant.' };
      if (managedConfigPresent()) return { ok: false, reason: 'Managed OpenCode configuration can override run isolation; this adapter refuses to bypass it.' };
      if (personalConfigPresent()) return { ok: false, reason: 'Sync only: OpenCode still loads the personal ~/.opencode directory with isolated XDG configuration; no supported switch excludes it while preserving HOME and sign-in.' };
      return { ok: true, reason: null };
    },

    build(spec) {
      if (!adapter.supports(spec).ok || !Number.isSafeInteger(spec.maxTurns) || spec.maxTurns <= 0) throw new Error('adapter_refused');
      const selected = selection(spec)!;
      const model = `${selected.provider}/${selected.model}`, paths = openCodeRunPaths(spec.runDir);
      const config = paths.config, configPath = join(config, 'opencode.json');
      const permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'allow',
        bash: 'allow', skill: 'allow', todowrite: 'allow', todoread: 'allow', external_directory: 'allow',
        task: 'deny', question: 'deny', webfetch: 'deny', websearch: 'deny', codesearch: 'deny', 'mcp*': 'deny', 'browser*': 'deny' };
      const baseURL = providers.get(selected.provider);
      const overlay = {
        $schema: 'https://opencode.ai/config.json', model, small_model: model, enabled_providers: [selected.provider],
        autoupdate: false, share: 'disabled', snapshot: false, plugin: [], mcp: {}, formatter: false, lsp: false,
        instructions: [], skills: { paths: [spec.skillsDir], urls: [] }, permission,
        agent: { build: { steps: spec.maxTurns } },
        ...(baseURL ? { provider: { [selected.provider]: { npm: '@ai-sdk/openai-compatible', name: selected.provider,
          options: { baseURL }, models: { [selected.model]: { name: selected.model, tool_call: true } } } } } : {}),
      };
      const argv = [spec.bin, '--pure', 'run', '--dir', spec.cwd, '--format', 'json', '--auto', '-m', model];
      if (spec.effort !== null) argv.push('--variant', spec.effort);
      return {
        // Pinned v1 has no no-history/ephemeral run flag. Its new session lives
        // in the run's isolated XDG data directory, never personal history.
        argv, env: { XDG_CONFIG_HOME: dirname(config), XDG_DATA_HOME: paths.data,
          XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state, OPENCODE_DB: paths.database,
          OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay),
          OPENCODE_PERMISSION: JSON.stringify(permission), OPENCODE_PURE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
          OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
          OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
          OPENCODE_DISABLE_SHARE: '1', OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1' },
        envUnset: ['SSH_AUTH_SOCK'], stdinFile: spec.promptFile,
        // Config-only file staging creates the isolated configuration parents.
        files: [{ path: configPath, content: '{}\n', mode: 0o600 }], projectFiles: [], spawnCwd: null, secretEnv: {},
      };
    },

    parse({ stdout, exitCode, signal }) {
      if (exitCode !== 0 || signal !== null) return failed();
      if (!stdout.trim()) return failed('output_empty');
      try {
        const events = rows(stdout, false), check = checkTools(events);
        if (check.mcpServers.length || check.browserTools.length) return failed('mcp_started');
        const messages = new Map<string, { parts: Map<string, string>; finished: boolean }>();
        let session: string | undefined, lastMessage: string | undefined;
        for (const row of events) {
          if (row.type === 'error') return failed();
          if (!['step_start', 'text', 'reasoning', 'tool_use', 'step_finish'].includes(row.type) ||
            typeof row.sessionID !== 'string' || !row.sessionID || (session && session !== row.sessionID)) return failed();
          session = row.sessionID;
          const value = part(row);
          const expected = { step_start: 'step-start', step_finish: 'step-finish', tool_use: 'tool', text: 'text', reasoning: 'reasoning' }[row.type];
          if (value.type !== expected) return failed();
          if (!messages.has(value.messageID)) messages.set(value.messageID, { parts: new Map(), finished: false });
          lastMessage = value.messageID;
          const message = messages.get(lastMessage)!;
          if (row.type === 'text') {
            if (typeof value.text !== 'string') return failed();
            message.parts.set(value.id, value.text);
          }
          if (row.type === 'tool_use') {
            const state = value.state as Record<string, unknown> | undefined;
            if (!state || !['completed', 'error'].includes(String(state.status)) || state.status === 'error') return failed();
          }
          if (row.type === 'step_finish') {
            if (typeof value.reason !== 'string') return failed();
            if (['error', 'length', 'content-filter', 'unknown'].includes(value.reason)) return failed();
            message.finished = value.reason === 'stop';
          }
        }
        if (!lastMessage) return failed();
        const final = messages.get(lastMessage)!;
        if (!final.finished || events.at(-1)?.type !== 'step_finish') return failed();
        const text = [...final.parts.values()].join('\n').trim();
        return text ? { ok: true, text, failureCode: null } : failed('output_empty');
      } catch { return failed(); }
    },

    selfCheck(stdoutSoFar) { const events = rows(stdoutSoFar, true); return events.length ? checkTools(events) : null; },
  };
  return adapter;
}

export const openCodeAdapter = createOpenCodeAdapter();

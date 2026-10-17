import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Adapter, ParsedResult, RunSpec } from '../adapter.js';

const exec = promisify(execFile);
const sandbox = JSON.stringify({ sandbox: {
  enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
} });
const desktopPath = /(?:^|[\\/])(?:Library[\\/]Application Support[\\/]Claude[\\/]claude-code|Claude\.app[\\/]Contents)(?:[\\/]|$)/iu;
const argument = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(value);
type Event = Record<string, unknown> & { type: string };

/** selfCheck receives accumulated stdout; only its unfinished last line may be incomplete. */
function events(stdout: string, partial: boolean): Event[] {
  const lines = stdout.split('\n');
  const result: Event[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      if (partial && index === lines.length - 1) break;
      throw error;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof (value as Event).type !== 'string' || !(value as Event).type) throw new Error('Invalid Claude event.');
    result.push(value as Event);
  }
  return result;
}

function checkInit(rows: Event[]): { mcpServers: string[]; browserTools: string[] } | null {
  let found = false;
  const mcpServers = new Set<string>(), browserTools = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'system' || row.subtype !== 'init') continue;
    found = true;
    if (!Array.isArray(row.mcp_servers) || !Array.isArray(row.tools)) throw new Error('Invalid Claude init event.');
    for (const server of row.mcp_servers) {
      // Any entry proves a server is present, even an unfamiliar server descriptor.
      const name = typeof server === 'string' ? server : server && typeof server === 'object' &&
        typeof server.name === 'string' ? server.name : '(unknown MCP server)';
      mcpServers.add(name || '(unknown MCP server)');
    }
    for (const tool of row.tools) {
      if (typeof tool !== 'string') throw new Error('Invalid Claude init tool.');
      if (tool.startsWith('mcp__') || tool.toLowerCase().includes('chrome')) browserTools.add(tool);
    }
  }
  return found ? { mcpServers: [...mcpServers], browserTools: [...browserTools] } : null;
}

function failed(failureCode: string): ParsedResult { return { ok: false, text: '', failureCode }; }

export const claudeCodeAdapter: Adapter = {
  info: {
    tool: 'claude-code', harness: 'claude_code', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
    skillsDir: '{runDir}/plugin/skills',
    // RunSpec carries a path, not prompt text. The final argument points at that file
    // for every size, including prompts above the core's 64 KiB inline-argument cap.
    promptVia: 'file', runHome: false,
  },

  async identity(bin) {
    try {
      if (!isAbsolute(bin) || basename(bin) === 'agent' || desktopPath.test(bin)) return { ok: false, version: null };
      const resolved = await realpath(bin);
      if (basename(resolved) === 'agent' || desktopPath.test(resolved)) return { ok: false, version: null };
      const { stdout, stderr } = await exec(resolved, ['--version'], {
        timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8', shell: false,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TERM: 'dumb', NO_COLOR: '1' },
      });
      const match = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?) \(Claude Code\)$/u.exec(stdout.trim());
      return match && !stderr.trim() ? { ok: true, version: match[1] } : { ok: false, version: null };
    } catch { return { ok: false, version: null }; }
  },

  supports(input) {
    if (input.provider !== null) return { ok: false, reason: 'Claude Code uses its saved login; explicit providers are unsupported.' };
    if (!argument(input.model)) return { ok: false, reason: 'A valid Claude Code model is required.' };
    if (input.effort !== null && !argument(input.effort)) return { ok: false, reason: 'Invalid Claude Code effort.' };
    if (input.access !== 'folder_only' && input.access !== 'full_access') return { ok: false, reason: 'Unsupported access mode.' };
    return { ok: true, reason: null };
  },

  build(spec: RunSpec) {
    if (!claudeCodeAdapter.supports(spec).ok) throw new Error('adapter_refused');
    const argv = [spec.bin, '-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none',
      '--no-session-persistence', '--plugin-dir', join(spec.runDir, 'plugin'), '--model', spec.model];
    if (spec.effort !== null) argv.push('--effort', spec.effort);
    if (spec.access === 'folder_only') argv.push('--permission-mode', 'acceptEdits', '--settings', sandbox);
    else argv.push('--permission-mode', 'bypassPermissions');
    argv.push('--strict-mcp-config', '--disallowedTools', 'mcp__*', '--no-chrome', `Follow the task in ${spec.promptFile}.`);
    return {
      argv, env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, envUnset: ['ANTHROPIC_API_KEY'], stdinFile: null,
      // TLS-25 stageSkills runs before startTool and must create the skills-only
      // plugin, including .claude-plugin/plugin.json with name "maddots-run".
      // Core config files are config-only; project staging rejects .maddots paths.
      files: [], projectFiles: [], spawnCwd: null, secretEnv: {},
    };
  },

  parse(result) {
    if (result.exitCode !== 0 || result.signal !== null) return failed('tool_failed');
    if (!result.stdout.trim()) return failed('output_empty');
    try {
      const rows = events(result.stdout, false), init = checkInit(rows);
      if (!init) return failed('tool_failed');
      if (init.mcpServers.length || init.browserTools.length) return failed('mcp_started');
      if (rows.some(row => row.type === 'error' || row.is_error === true ||
          (row.error !== undefined && row.error !== null))) return failed('tool_failed');
      const results = rows.filter(row => row.type === 'result');
      if (results.length !== 1) return failed('tool_failed');
      const final = results[0];
      if (final.subtype !== 'success' || final.is_error !== false || typeof final.result !== 'string' || rows.at(-1) !== final) return failed('tool_failed');
      const text = final.result.trim();
      return text ? { ok: true, text, failureCode: null } : failed('output_empty');
    } catch { return failed('tool_failed'); }
  },

  selfCheck(stdoutSoFar) { return checkInit(events(stdoutSoFar, true)); },
};

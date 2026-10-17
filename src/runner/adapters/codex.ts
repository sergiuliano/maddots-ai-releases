import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { runCommand, type Runner } from '../../config.js';
import type { Adapter, ParsedResult } from '../adapter.js';

const noMcp = ['--ignore-user-config', '--disable', 'apps', '--disable', 'plugins', '--disable', 'skill_mcp_dependency_install'];
const noBrowser = ['--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'browser_use_full_cdp_access', '--disable', 'in_app_browser', '--disable', 'computer_use'];
const outputLimit = 50 * 1024 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/u;
const effortName = /^[a-z][a-z0-9_-]*$/u;
const launcher = /^(?:agent|codex-pool|codex-security|codex-code-mode-host)(?:$|[.-])/u;
const failed = (failureCode = 'tool_failed'): ParsedResult => ({ ok: false, text: '', failureCode });

/** The output file is authoritative, never an intermediate agent_message event. */
function lastMessage(runDir: string): ParsedResult {
  let fd: number | undefined;
  try {
    fd = openSync(join(runDir, 'last-message.txt'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile()) return failed();
    if (info.size > outputLimit) return failed('output_too_large');
    // Bound the read even if the file grows after fstat, matching the log cap.
    const buffer = Buffer.alloc(Math.min(info.size + 1, outputLimit + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > info.size) return failed(bytes > outputLimit ? 'output_too_large' : 'tool_failed');
    const text = buffer.subarray(0, bytes).toString('utf8').trim();
    return text ? { ok: true, text, failureCode: null } : failed('output_empty');
  } catch (error) {
    return failed((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'output_empty' : 'tool_failed');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function createCodexAdapter(runner: Runner = runCommand): Adapter {
  return {
    info: { tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{cwd}/.agents/skills', promptVia: 'stdin', runHome: false },

    async identity(bin) {
      try {
        if (!isAbsolute(bin) || launcher.test(basename(bin))) return { ok: false, version: null };
        const canonical = await realpath(bin);
        if (launcher.test(basename(canonical))) return { ok: false, version: null };
        const { stdout } = await runner(canonical, ['--version'], { timeout: 10_000 });
        const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(stdout.trim());
        return { ok: match !== null, version: match?.[1] ?? null };
      } catch { return { ok: false, version: null }; }
    },

    supports({ provider, model, effort, access }) {
      if (provider !== null && provider !== 'ollama' && provider !== 'lmstudio') return { ok: false, reason: 'Codex runs support the saved login, Ollama or LM Studio only (R-04).' };
      if (access !== 'folder_only' && access !== 'full_access') return { ok: false, reason: 'Unsupported access mode.' };
      if (typeof model !== 'string' || !identifier.test(model)) return { ok: false, reason: 'A model id is required.' };
      // The matrix does not pin an effort enum; pass a safe single value to the CLI.
      if (effort !== null && (typeof effort !== 'string' || !effortName.test(effort))) return { ok: false, reason: 'Invalid reasoning effort.' };
      return { ok: true, reason: null };
    },

    build(spec) {
      if (!this.supports(spec).ok) throw new Error('adapter_refused');
      const argv = [spec.bin, 'exec', '--json', '-C', spec.cwd, '--ephemeral', '--skip-git-repo-check', '-o', join(spec.runDir, 'last-message.txt'), '-m', spec.model];
      if (spec.effort !== null) argv.push('-c', `model_reasoning_effort=${spec.effort}`);
      if (spec.provider !== null) argv.push('--oss', '--local-provider', spec.provider);
      argv.push(...(spec.access === 'folder_only' ? ['-s', 'workspace-write'] : ['--dangerously-bypass-approvals-and-sandbox']), ...noMcp, ...noBrowser, '-');
      return { argv, env: {}, envUnset: [], stdinFile: spec.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {} };
    },

    parse({ stdout, exitCode, signal, runDir }) {
      if (exitCode !== 0 || signal !== null) return failed();
      let completed = false;
      for (const line of stdout.split('\n').filter(line => line.trim())) {
        let event: unknown;
        try { event = JSON.parse(line); } catch { return failed(); }
        if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') return failed();
        if (event.type === 'turn.failed' || event.type === 'error') return failed();
        if (event.type === 'turn.completed') completed = true;
      }
      return completed ? lastMessage(runDir) : failed();
    },
  };
}

export const codexAdapter = createCodexAdapter();

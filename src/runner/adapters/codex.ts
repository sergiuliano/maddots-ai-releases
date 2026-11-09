import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import {LINUX_FOLDER_ONLY_REASON} from '../../shared/tool-capabilities.js';
import type {Runner} from '../../config.js';
import {assertLinuxToolClosure, linuxToolClosure} from '../../linux-tool-closures.js';
import {guardToolRunner, runToolCommand} from '../../tool-command.js';
import { executeAdapterProbe, type Adapter, type ParsedResult } from '../adapter.js';

const noMcp = ['--ignore-user-config', '--disable', 'apps', '--disable', 'plugins', '--disable', 'skill_mcp_dependency_install'];
const noBrowser = ['--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'browser_use_full_cdp_access', '--disable', 'in_app_browser', '--disable', 'computer_use'];
const outputLimit = 50 * 1024 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/u;
const effortName = /^[a-z][a-z0-9_-]*$/u;
const launcher = /^(?:agent|codex-pool|codex-security|codex-code-mode-host)(?:$|[.-])/u;
const failed = (failureCode = 'tool_failed'): ParsedResult => ({ ok: false, text: '', failureCode });

export interface CodexOptions {
  platform?: NodeJS.Platform;
}

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

export function createCodexAdapter(runner: Runner = runToolCommand, options: CodexOptions = {}): Adapter {
  const platform = options.platform ?? process.platform;
  const exec = guardToolRunner('codex', runner, {platform});

  return {
    info: { tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{cwd}/.agents/skills', promptVia: 'stdin', runHome: false },

    async identity(bin, operation) {
      try {
        if (!isAbsolute(bin) || launcher.test(basename(bin))) return { ok: false, version: null };
        const canonical = await realpath(bin);
        if (launcher.test(basename(canonical))) return { ok: false, version: null };
        if (platform === 'linux') await assertLinuxToolClosure('codex', bin);
        const { stdout } = await executeAdapterProbe(exec, 'codex.version', canonical, operation, {platform});
        const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(stdout.trim());
        return { ok: match !== null && (platform !== 'linux' || match[1] === linuxToolClosure('codex')!.version), version: match?.[1] ?? null };
      } catch { return { ok: false, version: null }; }
    },

    async preflight(input) {
      if (platform === 'darwin') return { ok: true, reason: null };
      const refuse = (reason: string) => ({ ok: false, reason: `Codex Linux prerequisite: ${reason}` });
      if (platform !== 'linux') return refuse('unsupported platform.');
      if (input?.operation?.signal?.aborted || (input?.operation?.deadline !== undefined &&
          (!Number.isFinite(input.operation.deadline) || Date.now() >= input.operation.deadline))) return refuse('the operation was cancelled or expired.');
      if (!input || (input.access !== 'folder_only' && input.access !== 'full_access')) return refuse('a verified access mode is required.');
      if (input.access === 'folder_only') return { ok: false, reason: LINUX_FOLDER_ONLY_REASON };
      if (!isAbsolute(input.bin)) return refuse('an absolute verified CLI path is required.');
      // S3 supplies a private /tmp and disables further user namespaces. Full
      // access uses that outer boundary, so Codex's nested sandbox and its
      // bubblewrap/interface prerequisites do not apply. Identity and S3
      // admission still run separately; this result grants neither.
      return { ok: true, reason: null };
    },

    supports({ provider, model, effort, access }) {
      if (platform !== 'darwin' && platform !== 'linux') return { ok: false, reason: 'Codex runs require macOS or Linux.' };
      if (provider !== null && provider !== 'ollama' && provider !== 'lmstudio') return { ok: false, reason: 'Codex runs support the saved login, Ollama or LM Studio only (R-04).' };
      if (access !== 'folder_only' && access !== 'full_access') return { ok: false, reason: 'Unsupported access mode.' };
      if (platform === 'linux' && access === 'folder_only') return { ok: false, reason: LINUX_FOLDER_ONLY_REASON };
      if (typeof model !== 'string' || !identifier.test(model)) return { ok: false, reason: 'A model id is required.' };
      // The matrix does not pin an effort enum; pass a safe single value to the CLI.
      if (effort !== null && (typeof effort !== 'string' || !effortName.test(effort))) return { ok: false, reason: 'Invalid reasoning effort.' };
      return { ok: true, reason: null };
    },

    build(spec) {
      if (!this.supports(spec).ok) throw new Error('adapter_refused');
      const argv = [spec.bin, 'exec', '--json', '-C', spec.cwd, '--ephemeral', '--skip-git-repo-check', '-o', join(spec.runDir, 'last-message.txt'), '-m', spec.model];
      // Disable the pinned CLI's startup version check explicitly. The Linux
      // closure's ownership and read-only mount separately prevent replacement.
      if (platform === 'linux') argv.push('-c', 'check_for_update_on_startup=false');
      if (spec.effort !== null) argv.push('-c', `model_reasoning_effort=${spec.effort}`);
      if (spec.provider !== null) argv.push('--oss', '--local-provider', spec.provider);
      argv.push(...(spec.access === 'folder_only' ? ['-s', 'workspace-write'] : ['--dangerously-bypass-approvals-and-sandbox']), ...noMcp, ...noBrowser, '-');
      // Match S3's private tmpfs. The short path leaves room for Unix socket
      // basenames, and never depends on a controller host runtime directory.
      const env: Record<string, string> = platform === 'linux' ? {
        TMPDIR: '/tmp',
        // The Linux lifecycle supplies only the explicitly selected auth.json.
        // Local-provider runs receive no saved-login transport.
        ...(spec.provider === null ? {CODEX_HOME: '/work/.mdai-home/codex'} : {}),
      } : {};
      return { argv, env, envUnset: [], stdinFile: spec.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {} };
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

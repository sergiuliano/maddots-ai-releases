import { isAbsolute } from 'node:path';
import { HelperError } from './config.js';
import { helperPlatform } from './platform.js';
import { RELEASE_IDENTITY } from './release-identity.js';
import { assertSystemRuntimeOperation } from './system-runtime-operation.js';
import type { CliOptions } from './cli-main.js';
export type { CliOptions } from './cli-main.js';

function argumentsFor(argv: string[], platform: NodeJS.Platform): { command: string; tokenFile?: string; restoreId?: string; rollback: boolean; all?: boolean; keyAction?: 'set' | 'status' | 'delete'; recovery?: 'seal' | 'complete' } {
  const commands = ['connect', 'status', 'allow', 'backups', 'import', 'uninstall', 'update', 'service'];
  const command = argv[0] ?? 'help';
  if (command === 'recovery' && platform === 'linux') {
    if (argv.length !== 2 || !['seal', 'complete'].includes(argv[1])) throw new HelperError('USAGE', 'Use maddots-ai recovery seal or maddots-ai recovery complete. Follow the S5-10 recovery procedure first.');
    return {command, rollback: false, recovery: argv[1] as 'seal' | 'complete'};
  }
  if (command === 'runs' || command === 'agent') return {command, rollback: false};
  if (command === 'keys') {
    const keyAction = argv[1];
    if (keyAction === 'status' && argv.length === 2 || (keyAction === 'set' || keyAction === 'delete') && argv[2] === 'deepseek' && argv.length === 3) {
      return {command, keyAction, rollback: false};
    }
    throw new HelperError('USAGE', 'Use maddots-ai keys set deepseek, keys status, or keys delete deepseek. Key values are accepted only at the hidden terminal prompt.');
  }
  if (['help', '--help', '-h', '--version', '--self-test'].includes(command)) {
    if (argv.length > 1) throw new HelperError('USAGE', 'Unexpected command arguments.');
    return { command, rollback: false };
  }
  if (!commands.includes(command)) throw new HelperError('USAGE', 'Unknown helper command. Run maddots-ai --help.');
  let tokenFile: string | undefined, restoreId: string | undefined, rollback = false, all = false;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--token-file' && !tokenFile && argv[index + 1] && !argv[index + 1].startsWith('-')) tokenFile = argv[++index];
    else if (argv[index] === '--rollback' && command === 'update' && !rollback) rollback = true;
    else if (argv[index] === '--all' && command === 'allow' && !all) all = true;
    else if (command === 'backups' && argv[index] === 'restore' && index === 1 && argv[index + 1] && /^[A-Za-z0-9_-]+$/.test(argv[index + 1]) && index + 2 === argv.length) restoreId = argv[++index];
    else throw new HelperError('USAGE', 'Unexpected command arguments. Run maddots-ai --help.');
  }
  return { command, tokenFile, restoreId, rollback, all };
}

export function assertRunsPlatform(platform: NodeJS.Platform): void {
  if (platform !== 'darwin' && platform !== 'linux') throw new HelperError('RUNS_PLATFORM_UNSUPPORTED', 'Agent runs are unsupported on this platform.');
}

/** Share the non-writing command checks with the Linux bootstrap preflight. */
export function validateCliLaunch(argv: string[], options: CliOptions = {}): ReturnType<typeof argumentsFor> {
  const requestedPlatform = options.platform ?? process.platform;
  const args = argumentsFor(argv, requestedPlatform);
  if (['help', '--help', '-h', '--version', '--self-test'].includes(args.command)) return args;
  if (args.command === 'runs' || args.command === 'agent') assertRunsPlatform(requestedPlatform);
  const platform = helperPlatform(requestedPlatform);
  if (args.command === 'keys' && platform !== 'darwin') throw new HelperError('PROVIDER_KEYS_UNSUPPORTED', 'DeepSeek provider keys are available only on macOS.');
  const isTTY = options.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (args.command === 'keys' && args.keyAction === 'set' && !isTTY) throw new HelperError('PROVIDER_KEY_TTY_REQUIRED', 'Setting a provider key requires an interactive terminal on this computer.');
  if (args.command === 'allow' && !isTTY) throw new HelperError('ALLOW_TTY_REQUIRED', 'Allow requires an interactive terminal on this computer.');
  if (args.command === 'update') assertSystemRuntimeOperation(options.runtime?.bundledRoot ?? '', 'update or roll back the system helper runtime');
  if (args.command === 'update' && !RELEASE_IDENTITY && !options.updates) {
    throw new HelperError('RELEASE_UNCONFIGURED', 'The source helper has no pinned release channel. Export it with the approved release identity first.');
  }
  if (args.tokenFile && !isAbsolute(args.tokenFile)) throw new HelperError('FILE_UNSAFE', 'The token file flag must name an absolute path.');
  return args;
}

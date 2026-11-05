import {isAbsolute} from 'node:path';
import {guardToolRunner, type ToolCommandOptions} from '../tool-command.js';

export type Access = 'folder_only' | 'full_access';

export interface AdapterOperationContext {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
}

export type AdapterPreflightInput = Pick<RunSpec, 'bin' | 'access'> &
  Partial<Pick<RunSpec, 'provider' | 'model' | 'effort' | 'cwd' | 'runDir'>> & {
    operation?: AdapterOperationContext;
  };

const probeDefinitions = {
  'codex.version': {tool: 'codex', purpose: 'identity', argv: ['--version'], timeout: 10_000, maxBuffer: 16 * 1024},
  'claude-code.version': {tool: 'claude-code', purpose: 'identity', argv: ['--version'], timeout: 10_000, maxBuffer: 16 * 1024},
  'opencode.version': {tool: 'opencode', purpose: 'identity', argv: ['--version'], timeout: 10_000, maxBuffer: 16 * 1024},
  'opencode.run-help': {tool: 'opencode', purpose: 'identity', argv: ['run', '--help'], timeout: 10_000, maxBuffer: 16 * 1024},
} as const;

export type AdapterProbeId = keyof typeof probeDefinitions;
export interface AdapterProbeProfile {
  readonly id: AdapterProbeId;
  readonly tool: 'codex' | 'claude-code' | 'opencode';
  readonly purpose: 'identity';
  readonly file: string;
  readonly argv: readonly string[];
}
const issuedProbes = new WeakSet<object>();

/** A genuine closed profile still needs current claimed-run authorization.
 * Its ID alone never grants permission or proves a trusted executable. */
export function isAdapterProbeProfile(value: unknown, file: string, argv: readonly string[]): value is AdapterProbeProfile {
  if (!value || typeof value !== 'object' || !issuedProbes.has(value)) return false;
  const profile = value as AdapterProbeProfile;
  return profile.file === file && profile.argv.length === argv.length && profile.argv.every((arg, index) => arg === argv[index]);
}

/** Only closed commands can carry adapter probe metadata. Transport still owns containment. */
export async function executeAdapterProbe(
  runner: (file: string, argv: readonly string[], options?: ToolCommandOptions) => Promise<{stdout: string; stderr: string}>,
  id: AdapterProbeId, file: string, operation?: AdapterOperationContext,
  options: Omit<ToolCommandOptions, 'timeout' | 'signal' | 'probe'> = {},
): Promise<{stdout: string; stderr: string}> {
  const definition = probeDefinitions[id];
  if (!definition || !isAbsolute(file) || file.includes('\0') || operation?.signal?.aborted) throw new Error('adapter_probe_refused');
  if (operation?.deadline !== undefined && (!Number.isFinite(operation.deadline) || Date.now() >= operation.deadline)) throw new Error('adapter_probe_refused');
  const profile: AdapterProbeProfile = Object.freeze({id, tool: definition.tool, purpose: definition.purpose,
    file, argv: Object.freeze([...definition.argv])});
  issuedProbes.add(profile);
  // Linux probes pay for isolated admission before the command can execute.
  // Allow the existing 20-second admission envelope plus command time without
  // extending the lifecycle's admission or separate cleanup caps.
  const allowance = (options.platform ?? process.platform) === 'linux' ? 30_000 : definition.timeout;
  const timeout = Math.min(allowance, operation?.deadline === undefined ? allowance : operation.deadline - Date.now());
  if (timeout <= 0) throw new Error('adapter_probe_refused');
  return guardToolRunner(definition.tool, runner, {platform: options.platform})(file, profile.argv,
    {...options, maxBuffer: definition.maxBuffer, timeout, signal: operation?.signal, probe: profile});
}

export interface AdapterInfo {
  tool: string;
  harness: string;
  card: string;
  folderOnly: 'os-sandbox' | 'no-shell' | 'none';
  mcpLevel: 'servers-off' | 'tools-denied';
  skillsDir: string;
  promptVia: 'stdin' | 'file' | 'arg';
  runHome: boolean;
}

export interface RunSpec {
  bin: string;
  cwd: string;
  runDir: string;
  promptFile: string;
  model: string;
  provider: string | null;
  effort: string | null;
  access: Access;
  skillsDir: string;
  /** Names from the verified staged builds, for tools with explicit skill lists. */
  skillNames?: readonly string[];
  maxTurns: number;
  timeoutSeconds: number;
  runHome: string | null;
}

export interface AdapterFile { path: string; content: string; mode: number }

export interface Invocation {
  argv: string[];
  env: Record<string, string>;
  envUnset: string[];
  stdinFile: string | null;
  files: AdapterFile[];
  projectFiles: AdapterFile[];
  spawnCwd: string | null;
  secretEnv: Record<string, 'provider-key:deepseek'>;
}

export interface ParsedResult { ok: boolean; text: string; failureCode: string | null; failureDetail?: 'workspace_not_pinned' }

export interface Adapter {
  info: AdapterInfo;
  identity(bin: string, operation?: AdapterOperationContext): Promise<{ ok: boolean; version: string | null }>;
  supports(input: Pick<RunSpec, 'provider' | 'model' | 'effort' | 'access'>): { ok: boolean; reason: string | null };
  /** Runtime prerequisites, including contained executable probes after admission. */
  preflight?(input?: AdapterPreflightInput): Promise<{ ok: boolean; reason: string | null }>;
  build(spec: RunSpec): Invocation;
  parse(result: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; runDir: string; cwd?: string }): ParsedResult;
  selfCheck?(stdoutSoFar: string): { mcpServers: string[]; browserTools: string[] } | null;
  agentSetup?(bin: string, folder: string): string[];
}

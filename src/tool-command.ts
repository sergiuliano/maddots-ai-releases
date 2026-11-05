import {execFile} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isAbsolute} from 'node:path';
import {TOOL_MATRIX, type ToolDefinition, type ToolMatrix} from './shared/tool-matrix.js';
import {CommandError, HelperError, cleanEnvironment, type CommandOptions, type Runner} from './config.js';
import {isAdapterProbeProfile, type AdapterProbeProfile} from './runner/adapter.js';
import {hasAcceptanceOperation, type LinuxAcceptanceOperation} from './runner/linux-authorization.js';

export type ToolCommandOptions = CommandOptions & {
  cwd?: string; maxBuffer?: number; encoding?: 'utf8'; shell?: false;
  tool?: string; matrix?: ToolMatrix; platform?: NodeJS.Platform;
  /** Closed command metadata, never a claim or an execution grant. */
  probe?: AdapterProbeProfile;
};

type ToolRunner = (file: string, args: readonly string[], options?: ToolCommandOptions) => Promise<{stdout: string; stderr: string}>;
type CommandContext = {platform?: NodeJS.Platform; matrix?: ToolMatrix};
type ClaimedToolCommands = {
  tool: string; file: string; deadline: number; contained: boolean;
  /** The same reviewed policy used to admit this run, scoped to its probes. */
  matrix?: ToolMatrix;
  signal?: AbortSignal; assertAllowed?: () => void; operation?: LinuxAcceptanceOperation;
};
const claims = new AsyncLocalStorage<ClaimedToolCommands & {active: boolean}>();
const linuxRefusal = 'This tool is not accepted for Linux. CLI commands require a claimed run and a closed probe in the MadDots sandbox; registration becomes available after Linux acceptance.';

/** The same pre-claim decision is used by discovery, delivery and execution. */
export function toolCommandPolicy(tool: ToolDefinition | undefined, platform: NodeJS.Platform = process.platform): {allowed: boolean; reason: string | null} {
  const allowed = platform !== 'linux' || tool?.run?.platforms?.linux?.accepted === true;
  return {allowed, reason: allowed ? null : linuxRefusal};
}

/** Issued only by the admitted core, for its selected executable and lifetime.
 * Owning storage or minting probe metadata alone never creates this authority. */
export async function withClaimedToolCommands<T>(context: ClaimedToolCommands, action: () => Promise<T>): Promise<T> {
  if (!context.contained || !isAbsolute(context.file) || !context.tool ||
      !Number.isFinite(context.deadline) || context.deadline <= Date.now() || context.signal?.aborted) {
    throw new HelperError('TOOL_PLATFORM_NOT_ACCEPTED', linuxRefusal);
  }
  context.assertAllowed?.();
  const claim = {...context, active: true};
  try {return await claims.run(claim, action);}
  finally {claim.active = false;}
}

export function assertToolCommandAllowed(file: string, args: readonly string[], options: ToolCommandOptions = {}, platform: NodeJS.Platform = process.platform): void {
  if (options.probe !== undefined && !isAdapterProbeProfile(options.probe, file, args)) throw new CommandError(undefined);
  const tool = options.tool ?? options.probe?.tool;
  if (toolCommandPolicy((options.matrix ?? TOOL_MATRIX).tools.find(entry => entry.key === tool), platform).allowed) return;
  const claim = claims.getStore();
  // Nested adapter probes do not carry the core's selected matrix themselves.
  // Inherit it only after matching the live claim and genuine closed profile;
  // an unaccepted candidate still requires its exact signed operation.
  if (!claim?.active || !claim.contained || claim.tool !== tool || claim.file !== file ||
      claim.signal?.aborted || options.signal?.aborted || Date.now() >= claim.deadline ||
      !isAdapterProbeProfile(options.probe, file, args) || options.probe.tool !== claim.tool ||
      !(toolCommandPolicy(claim.matrix?.tools.find(entry => entry.key === tool), platform).allowed ||
        hasAcceptanceOperation(claim.operation, {toolKey: claim.tool, platform: 'linux'}))) {
    throw new HelperError('TOOL_PLATFORM_NOT_ACCEPTED', linuxRefusal);
  }
  claim.assertAllowed?.();
}

/** A probe inherits only the exact admitted operation while its claim is live.
 * The utility still owns a fresh journal and server check at final release. */
export function currentClaimedToolOperation(file: string, args: readonly string[], options: ToolCommandOptions = {}): LinuxAcceptanceOperation | undefined {
  assertToolCommandAllowed(file, args, options, 'linux');
  const claim = claims.getStore();
  if (!claim?.active || !claim.contained || claim.signal?.aborted || options.signal?.aborted || Date.now() >= claim.deadline ||
      claim.file !== file || claim.tool !== (options.tool ?? options.probe?.tool) ||
      !isAdapterProbeProfile(options.probe, file, args) || options.probe.tool !== claim.tool) return;
  claim.assertAllowed?.();
  return claim.operation;
}

/** Guard dependency-injected runners too, before they can dispatch anything. */
export function guardToolRunner(tool: string, runner: ToolRunner = runToolCommand, context: CommandContext = {}): ToolRunner {
  return async (file, args, options = {}) => {
    const bound = {...options, tool, ...(context.matrix ? {matrix: context.matrix} : {})};
    assertToolCommandAllowed(file, args, bound, context.platform ?? process.platform);
    return runner(file, args, bound);
  };
}

/**
 * Tool utilities execute the same untrusted code as a run. A version/help,
 * package or registration command cannot use the controller's utility runner.
 * The Linux lifecycle supplies durable intent, retained containment, a private
 * workspace and the approved mount contract. It can refuse a profile, but can
 * never restore direct controller execFile as a fallback.
 */
export const runToolCommand: Runner & ((file: string, args: readonly string[], options?: ToolCommandOptions) => Promise<{stdout: string; stderr: string}>) =
  async (file, args, options: ToolCommandOptions = {}) => {
    assertToolCommandAllowed(file, args, options);
    if (process.platform === 'linux') {
      return (await import('./runner/linux-lifecycle.js')).runLinuxToolCommand(file, args, options);
    }
    return new Promise((done, reject) => {
      const child = execFile(file, [...args], {
        cwd: options.cwd, env: cleanEnvironment(options.env), timeout: options.timeout ?? 10_000,
        signal: options.signal, maxBuffer: options.maxBuffer ?? 1024 * 1024, encoding: 'utf8', shell: false,
      }, (error, stdout, stderr) => {
        if (error) reject(new CommandError(typeof error.code === 'number' ? error.code : undefined));
        else done({stdout, stderr});
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input);
    });
  };

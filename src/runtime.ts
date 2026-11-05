import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCliLaunch, type CliOptions } from './cli-validation.js';
import { HelperError, readConfig } from './config.js';
import { createPaths } from './paths.js';
import { RELEASE_IDENTITY, VERSION } from './release-identity.js';
import { selectRelease, type SelectedRelease, type UpdateOptions } from './updater.js';
import { assertSystemRuntime, systemRuntimeMode } from './system-runtime.js';

export type RuntimeContext = {
  bundledRoot: string;
  bootstrapVersion: string;
  bootstrapEntrypoint: string;
  runningRoot: string;
};

/** The bootstrap stays installed while the user service selects a verified runtime. */
export async function bundledRuntime(): Promise<RuntimeContext> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === 'maddots-ai' && manifest.bin?.['maddots-ai']) {
        return { bundledRoot: directory, bootstrapVersion: VERSION,
          bootstrapEntrypoint: fileURLToPath(new URL('./cli.js', import.meta.url)), runningRoot: directory };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new HelperError('INVALID_MANIFEST', 'The helper package could not be located.');
    directory = parent;
  }
}

type CliRunner = (argv: string[], options?: CliOptions) => Promise<void>;
type RuntimeDependencies = {
  select?: (options: UpdateOptions) => Promise<SelectedRelease>;
  load?: (root: string) => Promise<{ runCli: CliRunner }>;
};

// The injection seam is a function argument only. Environment variables cannot
// choose executable code, release identities or a different bootstrap root.
export async function launchCli(argv: string[], run: CliRunner, options: CliOptions = {}, dependencies: RuntimeDependencies = {}): Promise<void> {
  const context = options.runtime ?? await bundledRuntime();
  const fixedRuntime = systemRuntimeMode(context.bundledRoot);
  if (fixedRuntime && ['help', '--help', '-h', '--version'].includes(argv[0] ?? 'help')) {
    return run(argv, { ...options, runtime: context });
  }
  // Recovery must remain usable even when the selected runtime cannot import.
  // Fresh journal bootstrap validates the fixed installation in runCli before
  // lock preparation; cached code must never run that command first.
  if (argv[0] === '--self-test' || (['recovery', 'journal'].includes(argv[0]) && (options.platform ?? process.platform) === 'linux') ||
      (argv[0] === 'update' && argv.includes('--rollback')) || (!fixedRuntime && !RELEASE_IDENTITY && !dependencies.select)) {
    return run(argv, { ...options, runtime: context });
  }
  if (fixedRuntime) validateCliLaunch(argv, { ...options, runtime: context });
  const config = readConfig(options.env, options.home, options.platform), paths = await createPaths(config);
  if (fixedRuntime) await (options.assertRuntime ?? assertSystemRuntime)(context.bundledRoot, paths);
  // An equal-version retained CLI can run its older preparation before the
  // current CLI ever sees it. Establish the Linux barrier in the bootstrap,
  // before selecting or importing that code. Informational commands keep
  // their existing read-only dispatch and selected-version behavior.
  if (config.platform === 'linux' && (RELEASE_IDENTITY || fixedRuntime) && (fixedRuntime || options.home === undefined || options.prepareLocks) &&
      !['help', '--help', '-h', '--version'].includes(argv[0] ?? 'help')) {
    validateCliLaunch(argv, { ...options, runtime: context });
    try {
      const { prepareLockUpgrade } = await import('./write-lock-upgrade.js');
      await (options.prepareLocks ?? prepareLockUpgrade)(context, paths, options.timing);
    } catch (error) {
      if (error instanceof HelperError && ['HELPER_BUSY', 'PATH_UNSAFE', 'LINUX_LOCK_RETIREMENT_UNVERIFIED'].includes(error.code)) {
        (options.output ?? (line => process.stdout.write(line + '\n')))(error.message);
      }
      throw error;
    }
  }
  if (fixedRuntime) return run(argv, { ...options, runtime: context });
  const selected = await (dependencies.select ?? selectRelease)({
    paths, bundledRoot: context.bundledRoot, version: context.bootstrapVersion,
    env: config.env, timing: options.timing, signal: options.signal,
  });
  if (selected.root === context.bundledRoot) return run(argv, { ...options, runtime: context });
  const module = await (dependencies.load ?? (root => import(pathToFileURL(join(root, 'dist/cli.js')).href)))(selected.root);
  if (typeof module.runCli !== 'function') throw new HelperError('CANDIDATE_FAILED', 'The selected helper has no CLI entrypoint.');
  await module.runCli(argv, { ...options, runtime: { ...context, runningRoot: selected.root } });
}

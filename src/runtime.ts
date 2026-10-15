import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CliOptions } from './cli.js';
import { HelperError, readConfig } from './config.js';
import { createPaths } from './paths.js';
import { RELEASE_IDENTITY, VERSION } from './release-identity.js';
import { selectRelease, type SelectedRelease, type UpdateOptions } from './updater.js';

export type RuntimeContext = {
  bundledRoot: string;
  bootstrapVersion: string;
  bootstrapEntrypoint: string;
  runningRoot: string;
};

/** The bootstrap stays installed while launchd selects a verified runtime. */
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
  // Recovery must remain usable even when the selected runtime cannot import.
  if (argv[0] === '--self-test' || (argv[0] === 'update' && argv.includes('--rollback')) || (!RELEASE_IDENTITY && !dependencies.select)) {
    return run(argv, { ...options, runtime: context });
  }
  const config = readConfig(options.env, options.home), paths = await createPaths(config);
  const selected = await (dependencies.select ?? selectRelease)({
    paths, bundledRoot: context.bundledRoot, version: context.bootstrapVersion,
    env: config.env, timing: options.timing, signal: options.signal,
  });
  if (selected.root === context.bundledRoot) return run(argv, { ...options, runtime: context });
  const module = await (dependencies.load ?? (root => import(pathToFileURL(join(root, 'dist/cli.js')).href)))(selected.root);
  if (typeof module.runCli !== 'function') throw new HelperError('CANDIDATE_FAILED', 'The selected helper has no CLI entrypoint.');
  await module.runCli(argv, { ...options, runtime: { ...context, runningRoot: selected.root } });
}

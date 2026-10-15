import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { TOOL_MATRIX, validateToolMatrix, type ToolMatrix, type ToolVariant } from './shared/tool-matrix.js';
import { cleanEnvironment, runCommand, type Runner } from './config.js';

export type DetectedTool = {
  tool: string;
  variant: string;
  version: string | null;
  models: string[];
  syncOnly: boolean;
};
export type DetectionOptions = { home: string; env?: NodeJS.ProcessEnv; runner?: Runner; matrix?: ToolMatrix };

const MAX_OUTPUT = 1024 * 1024;
const MAX_PATHS = 256;

function expand(path: string, home: string): string {
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

async function binaryPaths(candidates: string[], home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const paths = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      const path = expand(candidate, home);
      if (isAbsolute(path) && await executable(path)) paths.add(resolve(path));
    } else {
      for (const directory of (env.PATH ?? '').split(':').slice(0, MAX_PATHS)) {
        if (!isAbsolute(directory)) continue;
        const path = join(directory, candidate);
        if (await executable(path)) paths.add(resolve(path));
      }
    }
  }
  return [...paths].slice(0, MAX_PATHS);
}

async function cursorClash(path: string, home: string): Promise<boolean> {
  const forbidden = resolve(home, '.grok/bin/agent');
  if (resolve(path) === forbidden) return true;
  const canonical = await realpath(path).catch(() => resolve(path));
  const forbiddenCanonical = await realpath(forbidden).catch(() => forbidden);
  return canonical === forbiddenCanonical || canonical === forbidden;
}

function version(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length <= 128 && /^[0-9][0-9A-Za-z.+_-]*$/u.test(normalized) ? normalized : null;
}

async function modelsFor(binary: string, variant: ToolVariant, runner: Runner, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (!variant.models.args || !variant.models.pattern) return [];
  try {
    const { stdout } = await runner(binary, variant.models.args, { timeout: 10_000, env });
    if (stdout.length > MAX_OUTPUT) return [];
    const pattern = new RegExp(variant.models.pattern, 'gimu');
    const found = new Set<string>();
    for (const match of stdout.matchAll(pattern)) {
      const name = (match[1] ?? match[0]).trim();
      if (name.length > 0 && name.length <= 80 && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/u.test(name)) found.add(name);
      if (found.size === 50) break;
    }
    return [...found];
  } catch { return []; }
}

async function matchingPaths(template: string, home: string): Promise<string[]> {
  const path = expand(template, home);
  if (!isAbsolute(path)) return [];
  let paths = ['/'];
  for (const segment of path.split('/').filter(Boolean)) {
    if (!segment.includes('*')) { paths = paths.map((path) => join(path, segment)); continue; }
    const pattern = new RegExp(`^${segment.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'u');
    const matched: string[] = [];
    for (const parent of paths) {
      const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isSymbolicLink() && pattern.test(entry.name)) matched.push(join(parent, entry.name));
        if (matched.length === MAX_PATHS) break;
      }
      if (matched.length === MAX_PATHS) break;
    }
    paths = matched;
  }
  return paths;
}

async function appVersion(app: string, runner: Runner, env: NodeJS.ProcessEnv): Promise<{ version: string | null } | null> {
  const info = join(app, 'Contents/Info.plist');
  try {
    const details = await stat(info);
    if (!details.isFile() || details.size > MAX_OUTPUT) return null;
    const { stdout } = await runner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info], { timeout: 10_000, env });
    if (stdout.length > MAX_OUTPUT) return null;
    const plist = JSON.parse(stdout) as Record<string, unknown>;
    if (!plist || typeof plist !== 'object' || typeof plist.CFBundleIdentifier !== 'string' || !plist.CFBundleIdentifier) return null;
    return { version: version(plist.CFBundleShortVersionString) ?? version(plist.CFBundleVersion) };
  } catch { return null; }
}

async function configuredVersion(path: string): Promise<{ version: string | null } | null> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_OUTPUT) return null;
    if (basename(path) !== 'package.json') return { version: null };
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string' || !manifest.name) return null;
    return { version: version(manifest.version) };
  } catch { return null; }
}

/** Detection is read-only; installed CLIs are executed directly after version confirmation. */
export async function detectTools(options: DetectionOptions): Promise<DetectedTool[]> {
  if (!isAbsolute(options.home)) throw new Error('DETECTION_HOME_INVALID');
  const home = resolve(options.home);
  const env = cleanEnvironment({ ...(options.env ?? process.env), HOME: home });
  const runner = options.runner ?? runCommand;
  const matrix = options.matrix ? validateToolMatrix(options.matrix) : TOOL_MATRIX;
  const found: DetectedTool[] = [];
  for (const tool of matrix.tools) {
    for (const variant of tool.variants) {
      let detected: { version: string | null; models: string[] } | null = null;
      for (const binary of await binaryPaths(variant.detect.binaries, home, env)) {
        if (tool.key === 'cursor' && await cursorClash(binary, home)) continue;
        try {
          const output = await runner(binary, variant.detect.versionArgs, { timeout: 10_000, env });
          if (output.stdout.length + output.stderr.length > MAX_OUTPUT) continue;
          // dsh shares its name with a distributed shell. Accept exactly the
          // bare stdout version, with at most one terminal line ending.
          const bareVersion = tool.key === 'deepseek-harness';
          if (bareVersion && output.stderr.length) continue;
          const text = bareVersion ? output.stdout.replace(/\r?\n$/u, '') : `${output.stdout}\n${output.stderr}`;
          const match = new RegExp(variant.detect.versionPattern, bareVersion ? 'u' : 'imu').exec(text);
          if (bareVersion && match?.[0] !== text) continue;
          const confirmedVersion = version(match?.[1] ?? match?.[0]);
          if (!confirmedVersion) continue;
          detected = { version: confirmedVersion, models: await modelsFor(binary, variant, runner, env) };
          break;
        } catch { /* An absent, incompatible, or broken variant is not installed. */ }
      }
      if (!detected) {
        for (const template of variant.detect.apps) {
          for (const path of await matchingPaths(template, home)) {
            const app = await appVersion(path, runner, env);
            if (app) { detected = { version: app.version, models: [] }; break; }
          }
          if (detected) break;
        }
      }
      if (!detected) {
        for (const template of variant.detect.configPaths) {
          for (const path of await matchingPaths(template, home)) {
            const config = await configuredVersion(path);
            if (config) { detected = { version: config.version, models: [] }; break; }
          }
          if (detected) break;
        }
      }
      if (detected) found.push({ tool: tool.key, variant: variant.key, version: detected.version, models: detected.models, syncOnly: variant.syncOnly });
    }
  }
  return found;
}

import { readFileSync } from 'node:fs';
import { HELPER_MAX_TOOLS } from './helper-protocol.js';

export type DeliveryTarget = 'folder' | 'claude-plugin' | 'desktop-zip';
export type ToolRoute = {
  kind: 'folder' | 'claude-plugin' | 'zip' | 'hermes-external-dir';
  path: string;
  readPath: string | null;
  target: DeliveryTarget;
  card: string;
};
export type ToolVariant = {
  key: string;
  label: string;
  syncOnly: boolean;
  detect: {
    binaries: string[];
    versionArgs: string[];
    versionPattern: string;
    apps: string[];
    configPaths: string[];
  };
  models: { args: string[] | null; pattern: string | null };
};
export type ToolRun = {
  adapter: string;
  card: string;
  offered: boolean;
  folderOnly: 'os-sandbox' | 'no-shell' | 'none';
  mcpLevel: 'servers-off' | 'tools-denied';
  reason: string | null;
  checkedAt: string;
};
export type ToolDefinition = {
  key: string;
  name: string;
  vendor: string;
  variants: ToolVariant[];
  route: string;
  reads: string[];
  legacyReads: string[];
  homes: { glob: string; skills: string }[];
  duplicateRule: 'none' | 'replace-local' | 'grok-ignore';
  reload: { kind: 'live' | 'command' | 'restart'; command: string | null };
  deliveryCard: string;
  run: ToolRun | null;
};
export type ToolMatrix = {
  format: 1;
  checkedAt: string;
  sources: { url: string; checkedAt: string }[];
  routes: Record<string, ToolRoute>;
  tools: ToolDefinition[];
};

function invalid(path: string): never {
  throw new Error(`TOOL_MATRIX_INVALID: ${path}`);
}

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record))) invalid(path);
  return record;
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid(path);
}

function choice(value: unknown, path: string, values: readonly string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) invalid(path);
}

function list(value: unknown, path: string, check: (item: unknown, itemPath: string) => void): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > 256) invalid(path);
  value.forEach((item, index) => check(item, `${path}[${index}]`));
}

function strings(value: unknown, path: string): asserts value is string[] {
  list(value, path, string);
}

function date(value: unknown, path: string): void {
  string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid(path);
  const time = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0, 10) !== value) invalid(path);
}

function template(value: unknown, path: string): void {
  string(value, path);
  if (!/^(?:~\/|<data>\/|\/)/u.test(value) || value.split('/').some((part, index) => part === '.' || part === '..' || (part === '' && index !== 0))) invalid(path);
}

function expression(value: unknown, path: string): void {
  string(value, path);
  try { new RegExp(value, 'imu'); } catch { invalid(path); }
}

/** Validate the colocated seed before either the server or helper uses its paths. */
export function validateToolMatrix(value: unknown): ToolMatrix {
  const matrix = object(value, 'matrix', ['format', 'checkedAt', 'sources', 'routes', 'tools']);
  if (matrix.format !== 1) invalid('format');
  date(matrix.checkedAt, 'checkedAt');
  list(matrix.sources, 'sources', (value, path) => {
    const source = object(value, path, ['url', 'checkedAt']);
    string(source.url, `${path}.url`);
    let url: URL;
    try { url = new URL(source.url); } catch { return invalid(`${path}.url`); }
    if (url.protocol !== 'https:' || url.username || url.password) invalid(`${path}.url`);
    date(source.checkedAt, `${path}.checkedAt`);
  });
  if (!matrix.routes || typeof matrix.routes !== 'object' || Array.isArray(matrix.routes)) invalid('routes');
  const routes = matrix.routes as Record<string, unknown>;
  if (!Object.keys(routes).length || Object.keys(routes).length > 64) invalid('routes');
  for (const [key, value] of Object.entries(routes)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(key)) invalid(`routes.${key}`);
    const route = object(value, `routes.${key}`, ['kind', 'path', 'readPath', 'target', 'card']);
    choice(route.kind, `routes.${key}.kind`, ['folder', 'claude-plugin', 'zip', 'hermes-external-dir']);
    template(route.path, `routes.${key}.path`);
    if (route.readPath !== null) template(route.readPath, `routes.${key}.readPath`);
    choice(route.target, `routes.${key}.target`, ['folder', 'claude-plugin', 'desktop-zip']);
    string(route.card, `routes.${key}.card`);
  }
  const toolKeys = new Set<string>();
  let variantCount = 0;
  list(matrix.tools, 'tools', (value, path) => {
    const tool = object(value, path, ['key', 'name', 'vendor', 'variants', 'route', 'reads', 'legacyReads', 'homes', 'duplicateRule', 'reload', 'deliveryCard', 'run']);
    string(tool.key, `${path}.key`);
    // Keys are stored as ai_tools.harness, whose CHECK allows at most 40 characters.
    if (!/^[a-z][a-z0-9-]{0,39}$/u.test(tool.key) || toolKeys.has(tool.key)) invalid(`${path}.key`);
    toolKeys.add(tool.key);
    string(tool.name, `${path}.name`);
    string(tool.vendor, `${path}.vendor`);
    string(tool.route, `${path}.route`);
    if (!Object.hasOwn(routes, tool.route)) invalid(`${path}.route`);
    list(tool.reads, `${path}.reads`, template);
    list(tool.legacyReads, `${path}.legacyReads`, template);
    list(tool.homes, `${path}.homes`, (value, path) => {
      const home = object(value, path, ['glob', 'skills']);
      template(home.glob, `${path}.glob`);
      template(home.skills, `${path}.skills`);
    });
    choice(tool.duplicateRule, `${path}.duplicateRule`, ['none', 'replace-local', 'grok-ignore']);
    const reload = object(tool.reload, `${path}.reload`, ['kind', 'command']);
    choice(reload.kind, `${path}.reload.kind`, ['live', 'command', 'restart']);
    if (reload.kind === 'command') string(reload.command, `${path}.reload.command`);
    else if (reload.command !== null) invalid(`${path}.reload.command`);
    string(tool.deliveryCard, `${path}.deliveryCard`);
    if (tool.run !== null) {
      const run = object(tool.run, `${path}.run`, ['adapter', 'card', 'offered', 'folderOnly', 'mcpLevel', 'reason', 'checkedAt']);
      string(run.adapter, `${path}.run.adapter`);
      if (!/^[a-z][a-z0-9-]{0,39}$/u.test(run.adapter)) invalid(`${path}.run.adapter`);
      string(run.card, `${path}.run.card`);
      if (typeof run.offered !== 'boolean') invalid(`${path}.run.offered`);
      choice(run.folderOnly, `${path}.run.folderOnly`, ['os-sandbox', 'no-shell', 'none']);
      choice(run.mcpLevel, `${path}.run.mcpLevel`, ['servers-off', 'tools-denied']);
      if (run.reason !== null) string(run.reason, `${path}.run.reason`);
      date(run.checkedAt, `${path}.run.checkedAt`);
    }
    const variantKeys = new Set<string>();
    list(tool.variants, `${path}.variants`, (value, path) => {
      if (++variantCount > HELPER_MAX_TOOLS) invalid('tools.variants');
      const variant = object(value, path, ['key', 'label', 'syncOnly', 'detect', 'models']);
      string(variant.key, `${path}.key`);
      if (!/^[a-z][a-z0-9-]*$/u.test(variant.key) || variantKeys.has(variant.key)) invalid(`${path}.key`);
      variantKeys.add(variant.key);
      string(variant.label, `${path}.label`);
      if (typeof variant.syncOnly !== 'boolean') invalid(`${path}.syncOnly`);
      const detect = object(variant.detect, `${path}.detect`, ['binaries', 'versionArgs', 'versionPattern', 'apps', 'configPaths']);
      strings(detect.binaries, `${path}.detect.binaries`);
      for (const binary of detect.binaries) {
        if (binary.includes('/')) template(binary, `${path}.detect.binaries`);
        else if (!/^[a-zA-Z0-9._-]+$/u.test(binary)) invalid(`${path}.detect.binaries`);
      }
      strings(detect.versionArgs, `${path}.detect.versionArgs`);
      expression(detect.versionPattern, `${path}.detect.versionPattern`);
      list(detect.apps, `${path}.detect.apps`, template);
      list(detect.configPaths, `${path}.detect.configPaths`, template);
      if (detect.binaries.length && !detect.versionArgs.length) invalid(`${path}.detect.versionArgs`);
      if (!detect.binaries.length && !detect.apps.length && !detect.configPaths.length) invalid(`${path}.detect`);
      if (!variant.syncOnly && !detect.binaries.length) invalid(`${path}.syncOnly`);
      const models = object(variant.models, `${path}.models`, ['args', 'pattern']);
      if (models.args !== null) {
        strings(models.args, `${path}.models.args`);
        if (!models.args.length || !detect.binaries.length) invalid(`${path}.models.args`);
        expression(models.pattern, `${path}.models.pattern`);
      } else if (models.pattern !== null) invalid(`${path}.models.pattern`);
    });
    if (!variantKeys.size) invalid(`${path}.variants`);
    if (tool.run !== null && !(tool.variants as ToolVariant[]).some((variant) => variant.key === 'cli' && !variant.syncOnly)) invalid(`${path}.run`);
  });
  if (!toolKeys.size) invalid('tools');
  return value as ToolMatrix;
}

/** URL resolution survives TLS-12 copying both files into src/shared/. */
export function loadToolMatrix(source: string | URL = new URL('./tool-matrix.json', import.meta.url)): ToolMatrix {
  return validateToolMatrix(JSON.parse(readFileSync(source, 'utf8')) as unknown);
}

export const TOOL_MATRIX = loadToolMatrix();

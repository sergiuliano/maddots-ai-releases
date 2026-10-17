import {HELPER_ROUTES, HELPER_SCHEMAS} from './helper-protocol.js';
import {SYNC_SCHEMAS} from './sync-protocol.js';

export const HELPER_VALIDATION_PATHS_HEADER = 'x-mdai-validation-paths';
export type HelperHttpDiagnostic = {method: string; route: string; status: number; code: string; instancePaths?: string[]};
const routes: readonly string[] = [...Object.values(HELPER_ROUTES), '/api/helper/inventory', '/api/helper/plan',
  '/api/helper/builds/:digest', '/api/helper/allow', '/api/helper/imports', '/api/helper/imports/:sessionId/uploads',
  '/api/helper/imports/:sessionId/results', '/api/helper/runs/device-key'];

/** Match authored templates, discarding query strings and parameter values. */
export function helperRouteTemplate(pathname: string): string | undefined {
  const parts = pathname.split('/');
  return routes.find(route => {
    const template = route.split('/');
    return template.length === parts.length && template.every((part, index) => part.startsWith(':') ? Boolean(parts[index]) : part === parts[index]);
  });
}

function properties(schema: unknown, names: Set<string>): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {for (const item of schema) properties(item, names); return;}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') for (const name of Object.keys(value)) names.add(name);
    properties(value, names);
  }
}
const schemaNames = new Set(['sessionId', 'folders', 'symlinkTarget', 'findings', 'rule', 'line', 'reason', 'backupId', 'publicKey', 'proof']);
properties(HELPER_SCHEMAS, schemaNames); properties(SYNC_SCHEMAS, schemaNames);

/** Headers are untrusted too: keep only schema keys and array indices. */
export function safeHelperInstancePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 64).filter((path): path is string => typeof path === 'string' && path.length <= 256 &&
    (path === '' || path.startsWith('/') && path.slice(1).split('/').every(part => schemaNames.has(part) || /^(?:0|[1-9][0-9]{0,7})$/.test(part)))))];
}

/** Follow the request schema, never arbitrary object keys supplied in a body. */
export function schemaInstancePath(schema: unknown, path: string): boolean {
  if (path === '') return true;
  if (!path.startsWith('/') || path.length > 256) return false;
  const walk = (current: unknown, segments: string[]): boolean => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    if (!segments.length) return true;
    const node = current as Record<string, unknown>;
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[key]) && node[key].some(branch => walk(branch, segments))) return true;
    }
    const [segment, ...rest] = segments;
    if (node.type === 'array' && /^(?:0|[1-9][0-9]{0,7})$/.test(segment)) return walk(node.items, rest);
    const fields = node.properties;
    return Boolean(fields && typeof fields === 'object' && Object.hasOwn(fields, segment) && walk((fields as Record<string, unknown>)[segment], rest));
  };
  return walk(schema, path.slice(1).split('/'));
}

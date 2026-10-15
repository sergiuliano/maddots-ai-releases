import { createHash } from 'node:crypto';

/** Section 4.4: stable plan identity, including the answered digest for local edits. */
export function planItemId(item: {helperId: string; skillId: string; target: string; workspaceId: string; name: string;
  kind: string; version: number; settingsRevision: number; agentId: string | null; localDigest: string | null}): string {
  const values = [item.helperId, item.skillId, item.target, item.workspaceId, item.name, item.kind,
    String(item.version), String(item.settingsRevision), item.agentId ?? ''];
  if (item.kind === 'local_newer') values.push(item.localDigest ?? '');
  return createHash('sha256').update(values.join('\n')).digest('hex');
}

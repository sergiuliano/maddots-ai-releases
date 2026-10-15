import {SKILL_LIMITS} from './skill-limits.js';

/** TLS-01 wire contract. Later cards extend this module for inventory and builds. */
export const HELPER_SCOPES = ['sync', 'import_upload', 'proposal_upload', 'run_claim'] as const;
export type HelperScope = typeof HELPER_SCOPES[number];
export const PAIRING_SCOPES = ['sync', 'import_upload', 'proposal_upload'] as const satisfies readonly HelperScope[];
export const SKILLS_TOKEN_PREFIX = 'mdai_skill_';
export const SKILLS_TOKEN_PATTERN = '^mdai_skill_[A-Za-z0-9_-]{43}$';
export const DEVICE_CODE_PATTERN = '^[A-Za-z0-9_-]{43}$';
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const USER_CODE_PATTERN = '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$';
export const PAIRING_EXPIRES_SECONDS = 300;
export const PAIRING_POLL_SECONDS = 3;
export const HELPER_BODY_LIMIT = 64 * 1024;
export const HELPER_UPLOAD_BODY_LIMIT = 14 * 1024 * 1024;
export const HELPER_MAX_TOOLS = 40;
export const HELPER_MAX_MODELS = 50;
export const HELPER_TOKEN_ROTATE_MS = 24 * 60 * 60 * 1000;
export const HELPER_TOKEN_GRACE_MS = 60 * 60 * 1000;
export const HELPER_TOKEN_IDLE_MS = 30 * HELPER_TOKEN_ROTATE_MS;
export const HELPER_TOKEN_RENEW_MS = 90 * HELPER_TOKEN_ROTATE_MS;
export const HELPER_ROUTES = {
  pairingStart: '/api/helper/pairings', pairingPoll: '/api/helper/pairings/poll',
  status: '/api/helper/status', rotate: '/api/helper/token/rotate', revoke: '/api/helper/token/revoke',
  tools: '/api/helper/tools', proposals: '/api/helper/proposals',
} as const;
export const TOOL_BROWSER_ROUTES = {
  inspect: '/api/tools/pairings/inspect', approve: '/api/tools/pairings/approve', deny: '/api/tools/pairings/deny',
  pending: '/api/tools/pending', approveAdded: '/api/tools/pending/:id/approve', declineAdded: '/api/tools/pending/:id/decline',
  revokeConnection: '/api/tools/connections/:id/revoke', renewComputer: '/api/tools/computers/:helperId/renew',
  revokeComputer: '/api/tools/computers/:helperId/revoke', revokeAll: '/api/tools/revoke-all',
  revokeLink: '/api/tools/revoke-link/:connectionId',
} as const;
export const HELPER_ERROR_CODES = [
  'TOKEN_REQUIRED', 'TOKEN_FOREIGN', 'TOKEN_INVALID', 'TOKEN_ROTATED', 'TOKEN_REVOKED',
  'TOKEN_LAPSED', 'TOKEN_RENEW_REQUIRED', 'SCOPE_MISSING', 'INVALID_PAIRING',
  'PAIRING_RATE_LIMIT', 'PAIRING_SLOW_DOWN', 'PAIRING_MISMATCH_ACK', 'NOT_OWNER',
  'MADDOTS_UNAVAILABLE', 'PROPOSAL_ALREADY_UPLOADED',
] as const;
export type HelperErrorCode = typeof HELPER_ERROR_CODES[number];
export type HelperAuthKind = 'public' | 'browser' | 'step-up' | 'skills token';
export type HelperOS = 'macos' | 'linux' | 'windows';
export type ToolIdentity = {tool: string; variant: string};
export type ReportedTool = ToolIdentity & {version: string | null; models: string[]; syncOnly: boolean};
export type SendProposalInstruction = {
  type: 'send_proposal'; itemId: string; intent: 'proposal' | 'publish'; baseVersion: number;
  placeholders: {name: string; value: string}[];
  nameMap: {sourceName: string; deliveredName: string}[];
  modelLine: string | null;
};
export type HelperProposalUpload = {
  itemId: string; skillId: string; baseVersion: number; localDigest: string; intent: 'proposal' | 'publish';
  files: {path: string; mode: '100644' | '100755'; content: string}[];
};
export type ToolConnection = ToolIdentity & {id: string};
export type PairingStartRequest = {helperVersion: string; computerName: string; os: HelperOS; tools: ReportedTool[]};
export type PairingStartResponse = {deviceCode: string; userCode: string; expiresAt: string; expiresIn: 300; interval: 3; connectUrl: string};
export type PairingInspectRequest = {userCode: string; pickedTool?: string};
export type PairingWorkspace = {id: string; name: string; role: 'admin' | 'pm' | 'member'};
export type PairingInspectResponse = {
  computerName: string; os: HelperOS; helperVersion: string; tools: (ReportedTool & {picked: boolean})[];
  ip: string; country: string | null; createdAt: string; expiresAt: string; ageSeconds: number;
  currentWorkspace: PairingWorkspace | null; workspaces: PairingWorkspace[];
  mismatches: {network: boolean; country: boolean; pickedToolMissing: boolean};
};
export type ToolApproval = {workspaceScope?: 'workspace' | 'all'; workspaceId?: string; models?: Record<string, string[]>};
export type PairingApproveRequest = ToolApproval & {userCode: string; tools: ToolIdentity[]; acknowledgeMismatch?: boolean};
export type HelperAccount = {id: string; name: string};
export type HelperTokenResponse = {token: string; renewBy: string; idleLapseAt: string};
export type PairingConnectedResponse = HelperTokenResponse & {
  status: 'connected'; helperId: string; account: HelperAccount; scopes: HelperScope[]; connections: ToolConnection[];
};
export type PairingPollResponse = {status: 'pending'; expiresAt: string} | PairingConnectedResponse;
export type HelperStatus = {
  account: HelperAccount; computerName: string; scopes: HelperScope[]; renewBy: string;
  idleLapseAt: string; connections: ToolConnection[]; pending: ToolIdentity[];
};
export type AddedToolsResponse = {pending: ToolIdentity[]; connected: ToolConnection[]};
export type PendingTool = ReportedTool & {id: string; helperId: string; computerName: string; expiresAt: string};
export type PairingApproveResponse = {ok: true; helperId: string; connections: ToolConnection[]};

/** Pure JSON schemas are also usable in the exported helper package. */
export function helperSchemaObject(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return {type: 'object', additionalProperties: false, properties, required};
}
const line = (maxLength: number, minLength = 1) => ({type: 'string', minLength, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]*$'});
const key = {type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z][a-z0-9_-]*$'};
const id = line(128);
const uuid = {type: 'string', format: 'uuid'};
const date = {type: 'string', format: 'date-time'};
const array = (items: unknown, maxItems: number, minItems = 0) => ({type: 'array', items, maxItems, minItems});
const toolIdentity = helperSchemaObject({tool: key, variant: key});
const connection = helperSchemaObject({id, tool: key, variant: key});
const reportedTool = helperSchemaObject({
  tool: key, variant: key, version: {anyOf: [line(128), {type: 'null'}]},
  models: {...array(line(80), HELPER_MAX_MODELS), uniqueItems: true}, syncOnly: {type: 'boolean'},
});
const computerName = {type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9 ._-]+$'};
const userCode = {type: 'string', minLength: 8, maxLength: 32, pattern: '^[A-Za-z0-9 -]+$'};
const account = helperSchemaObject({id, name: line(256)});
const workspace = helperSchemaObject({id, name: line(256), role: {type: 'string', enum: ['admin', 'pm', 'member']}});
const scopes = {type: 'array', items: {type: 'string', enum: HELPER_SCOPES}, uniqueItems: true, minItems: 1, maxItems: HELPER_SCOPES.length};
const tokenFields = {token: {type: 'string', pattern: SKILLS_TOKEN_PATTERN}, renewBy: date, idleLapseAt: date};
const approvalFields = {
  workspaceScope: {type: 'string', enum: ['workspace', 'all']}, workspaceId: id,
  models: {type: 'object', additionalProperties: false, maxProperties: HELPER_MAX_TOOLS,
    patternProperties: {'^[a-z][a-z0-9_-]{0,79}$': {...array(line(80), 20), uniqueItems: true}}},
};

export const HELPER_SCHEMAS = {
  empty: helperSchemaObject({}),
  toolIdentity, reportedTool, connection, account, scopes,
  pairingStart: helperSchemaObject({helperVersion: line(128), computerName, os: {type: 'string', enum: ['macos', 'linux', 'windows']}, tools: array(reportedTool, HELPER_MAX_TOOLS)}),
  pairingPoll: helperSchemaObject({deviceCode: {type: 'string', pattern: DEVICE_CODE_PATTERN}}),
  pairingInspect: helperSchemaObject({userCode, pickedTool: key}, ['userCode']),
  pairingApprove: helperSchemaObject({userCode, tools: {...array(toolIdentity, HELPER_MAX_TOOLS, 1), uniqueItems: true}, ...approvalFields, acknowledgeMismatch: {type: 'boolean'}}, ['userCode', 'tools']),
  userCode: helperSchemaObject({userCode}),
  addedTools: helperSchemaObject({tools: {...array(reportedTool, HELPER_MAX_TOOLS), uniqueItems: true}}),
  addedApprove: helperSchemaObject(approvalFields, []),
  pairingStartResponse: helperSchemaObject({
    deviceCode: {type: 'string', pattern: DEVICE_CODE_PATTERN}, userCode: {type: 'string', pattern: USER_CODE_PATTERN},
    expiresAt: date, expiresIn: {type: 'integer', const: PAIRING_EXPIRES_SECONDS},
    interval: {type: 'integer', const: PAIRING_POLL_SECONDS}, connectUrl: {type: 'string', format: 'uri', maxLength: 2048},
  }),
  pairingInspectResponse: helperSchemaObject({
    computerName, os: {type: 'string', enum: ['macos', 'linux', 'windows']}, helperVersion: line(128),
    tools: array(helperSchemaObject({...reportedTool.properties, picked: {type: 'boolean'}}), HELPER_MAX_TOOLS),
    ip: line(128), country: {anyOf: [{type: 'string', pattern: '^[A-Z]{2}$'}, {type: 'null'}]},
    createdAt: date, expiresAt: date, ageSeconds: {type: 'integer', minimum: 0},
    currentWorkspace: {anyOf: [workspace, {type: 'null'}]}, workspaces: array(workspace, 1000),
    mismatches: helperSchemaObject({network: {type: 'boolean'}, country: {type: 'boolean'}, pickedToolMissing: {type: 'boolean'}}),
  }),
  pairingApproveResponse: helperSchemaObject({ok: {type: 'boolean', const: true}, helperId: id, connections: array(connection, HELPER_MAX_TOOLS)}),
  pendingToolsResponse: {type: 'array', items: helperSchemaObject({id, helperId: id, computerName, ...reportedTool.properties, expiresAt: date})},
  pairingPollResponse: {anyOf: [
    helperSchemaObject({status: {type: 'string', const: 'pending'}, expiresAt: date}),
    helperSchemaObject({status: {type: 'string', const: 'connected'}, ...tokenFields, helperId: id, account, scopes,
      connections: array(connection, HELPER_MAX_TOOLS)}),
  ]},
  helperStatus: helperSchemaObject({account, computerName, scopes, renewBy: date, idleLapseAt: date,
    connections: array(connection, HELPER_MAX_TOOLS), pending: array(toolIdentity, HELPER_MAX_TOOLS)}),
  tokenResponse: helperSchemaObject(tokenFields),
  toolsResponse: helperSchemaObject({pending: array(toolIdentity, HELPER_MAX_TOOLS), connected: array(connection, HELPER_MAX_TOOLS)}),
  proposalUpload: helperSchemaObject({itemId: id, skillId: uuid, baseVersion: {type: 'integer', minimum: 1},
    localDigest: {type: 'string', pattern: '^[a-f0-9]{64}$'}, intent: {enum: ['proposal', 'publish']},
    files: array(helperSchemaObject({path: line(SKILL_LIMITS.pathBytes), mode: {enum: ['100644', '100755']},
      content: {type: 'string', maxLength: 4 * Math.ceil(SKILL_LIMITS.fileBytes / 3)}}), SKILL_LIMITS.files, 1)}),
  proposalUploadResponse: helperSchemaObject({proposalId: uuid, skillId: uuid, draftVersionId: {anyOf: [uuid, {type: 'null'}]}}),
} as const;

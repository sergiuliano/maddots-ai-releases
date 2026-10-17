import type {BuildLevel, BuildTarget} from './build-format.js';
import {HELPER_SCHEMAS, helperSchemaObject as object, type HelperOS, type ReportedTool} from './helper-protocol.js';

export const SYNC_ANSWERS = ['update', 'later', 'always', 'send_proposal', 'publish', 'keep_local', 'replace', 'replace_unmanaged'] as const;
export type SyncAnswer = typeof SYNC_ANSWERS[number];
export interface PlanItem {
  itemId: string; kind: 'install' | 'update' | 'local_newer' | 'forced_remove' | 'forced_restore';
  skillId: string; name: string; sourceName: string; level: BuildLevel; workspaceId: string; workspaceIds: string[];
  boardIds: string[]; target: BuildTarget; route: string; fromVersion: number | null; version: number;
  settingsRevision: number; digest: string; hasCode: boolean; draft: boolean; dependencyOf: string | null;
  missingDependencies: string[]; forAgentIds: string[];
  state: 'asking' | 'approved' | 'later' | 'kept_local' | 'forced' | 'held' | 'delivered' | 'failed';
  answer: SyncAnswer | null; reason: 'revoked' | 'archived' | 'security_fix' | null;
  availableAnswers?: SyncAnswer[];
  dependencyIds?: string[]; outsideWorkspaceDependencies?: boolean;
  restartHints: {tool: string; reload: 'live' | 'command' | 'restart'; command: string | null}[];
}
export type SyncInstruction =
  | {type: 'replace_local'; sessionId: string; skillId: string; home: string; folderName: string; alsoLinkedFrom: {home: string; folderName: string}[]}
  | {type: 'send_proposal'; itemId: string; intent: 'proposal' | 'publish'; baseVersion: number; placeholders: {name: string; value: string}[]; nameMap: {sourceName: string; deliveredName: string}[]; modelLine: string | null};
export type SyncPlan = {planRevision: string; degraded: boolean; pollAfterSeconds: number; items: PlanItem[];
  revoked: {skillId: string; digest: string}[]; instructions: SyncInstruction[]};
export type ManagedInventory = {skillId: string; target: BuildTarget; name: string; version: number; settingsRevision: number;
  digest: string; localDigest: string | null; state: 'ok' | 'edited' | 'missing' | 'held'};
export type DeliveryError = {skillId: string; target: BuildTarget; name: string; code: string};
export type SyncInventory = {
  helperVersion: string; computerName: string; os: HelperOS; tokenStorage: 'keychain' | 'file'; tools: ReportedTool[];
  managed: ManagedInventory[]; duplicates: {tool: string; home: string; folderName: string; skillId: string | null}[];
  unmanaged: {home: string; folderName: string; link: {targetName: string; targetHome: string | null} | null; hasScripts: boolean;
    canonicalConflict?: {skillId: string; target: BuildTarget; name: string}}[];
  holdingCount: number; deliveryErrors: DeliveryError[];
};
export type SyncAnswersRequest = {helperId: string; answers: {itemId: string; answer: SyncAnswer}[]};
export type SyncQuestionGroup = {helperId: string; computerName: string; items: PlanItem[]; waitingCount: number;
  duplicates: SyncInventory['duplicates']; agents: {id: string; name: string}[]; restartHints: PlanItem['restartHints']; initialPlanReady?: boolean};
export type SyncQuestionsResponse = {helpers: SyncQuestionGroup[]};
export type AllowReportsRequest = {holdingCount: number; reports: {skillId: string; version: number; digest: string; tools: string[]; allowedAt: string}[]};
export const SYNC_INVENTORY_BODY_LIMIT = 4 * 1024 * 1024;
export const SYNC_ALLOW_BODY_LIMIT = 256 * 1024;
const string = (maxLength = 128) => ({type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*$'});
const name = {type: 'string', minLength: 1, maxLength: 255, pattern: '^(?!\\.{1,2}$)[^/\\\\:\\u0000-\\u001f\\u007f-\\u009f]+$'};
const key = {type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'};
const digest = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const integer = (minimum = 0) => ({type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER});
const choice = (values: readonly string[]) => ({type: 'string', enum: values});
const array = (items: unknown, maxItems = 2000) => ({type: 'array', items, maxItems});
const nullable = (schema: unknown) => ({anyOf: [schema, {type: 'null'}]});
const target = choice(['folder', 'claude-plugin', 'desktop-zip']);
const home = {type: 'string', minLength: 1, maxLength: 255, pattern: '^(?![A-Za-z]:)(?!.*(?:^|:)\\.{1,2}(?::|$))[A-Za-z0-9_.%:-]+$'};
const managed = object({skillId: key, target, name, version: integer(1), settingsRevision: integer(), digest,
  localDigest: nullable(digest), state: choice(['ok', 'edited', 'missing', 'held'])});
const item = object({itemId: digest, kind: choice(['install', 'update', 'local_newer', 'forced_remove', 'forced_restore']),
  skillId: key, name, sourceName: name, level: choice(['global', 'workspace', 'board']), workspaceId: key,
  workspaceIds: array(key), boardIds: array(key), target, route: key, fromVersion: nullable(integer(1)), version: integer(1),
  settingsRevision: integer(), digest, hasCode: {type: 'boolean'}, draft: {type: 'boolean'}, dependencyOf: nullable(key),
  missingDependencies: array(key), forAgentIds: array(key, 1), state: choice(['asking', 'approved', 'later', 'kept_local', 'forced', 'held', 'delivered', 'failed']),
  answer: nullable(choice(SYNC_ANSWERS)), reason: nullable(choice(['revoked', 'archived', 'security_fix'])), availableAnswers: array(choice(SYNC_ANSWERS), SYNC_ANSWERS.length),
  dependencyIds: array(digest), outsideWorkspaceDependencies: {type: 'boolean'},
  restartHints: array(object({tool: key, reload: choice(['live', 'command', 'restart']), command: nullable(string(2048))}), 40)},
['itemId', 'kind', 'skillId', 'name', 'sourceName', 'level', 'workspaceId', 'workspaceIds', 'boardIds', 'target', 'route', 'fromVersion', 'version',
  'settingsRevision', 'digest', 'hasCode', 'draft', 'dependencyOf', 'missingDependencies', 'forAgentIds', 'state', 'answer', 'reason', 'restartHints']);
const folderRef = object({home, folderName: name});
const instruction = {anyOf: [
  object({type: {const: 'replace_local', type: 'string'}, sessionId: key, skillId: key, home, folderName: name, alsoLinkedFrom: array(folderRef)}),
  object({type: {const: 'send_proposal', type: 'string'}, itemId: digest, intent: choice(['proposal', 'publish']), baseVersion: integer(1),
    placeholders: array(object({name: key, value: {type: 'string', maxLength: 16384}})),
    nameMap: array(object({sourceName: name, deliveredName: name})), modelLine: nullable(string(1024))}),
]};
export const SYNC_SCHEMAS = {
  empty: object({}), item, managed,
  inventory: object({helperVersion: string(), computerName: {type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9 ._-]+$'},
    os: choice(['macos', 'linux', 'windows']), tokenStorage: choice(['keychain', 'file']), tools: array(HELPER_SCHEMAS.reportedTool, 40), managed: array(managed),
    duplicates: array(object({tool: key, home, folderName: name, skillId: nullable(key)})),
    unmanaged: array(object({home, folderName: name, link: nullable(object({targetName: name, targetHome: nullable(home)})), hasScripts: {type: 'boolean'},
      canonicalConflict: object({skillId: key, target, name})}, ['home', 'folderName', 'link', 'hasScripts'])),
    holdingCount: integer(), deliveryErrors: array(object({skillId: key, target, name, code: {type: 'string', pattern: '^[A-Z_]{1,60}$'}}))}),
  allow: object({holdingCount: integer(), reports: array(object({skillId: key, version: integer(1), digest,
    tools: {...array(key, 40), minItems: 1, uniqueItems: true}, allowedAt: {type: 'string', format: 'date-time'}}))}),
  answers: object({helperId: key, answers: {...array(object({itemId: digest, answer: choice(SYNC_ANSWERS)})), minItems: 1}}),
  updateAll: object({}), helperParams: object({helperId: key}), digestParams: object({digest}), buildQuery: object({itemId: digest}, []),
  questionsQuery: object({helperId: key, workspaceId: key}, []),
  updateAllQuery: object({workspaceId: key}, []),
  plan: object({planRevision: string(200), degraded: {type: 'boolean'}, pollAfterSeconds: {type: 'integer', minimum: 1, maximum: 86400},
    items: array(item), revoked: array(object({skillId: key, digest})), instructions: array(instruction)}),
  questions: object({helpers: array(object({helperId: key, computerName: string(80), items: array(item), waitingCount: integer(), initialPlanReady: {type: 'boolean'},
    duplicates: array(object({tool: key, home, folderName: name, skillId: nullable(key)})), agents: array(object({id: key, name: string(200)})),
    restartHints: array(object({tool: key, reload: choice(['live', 'command', 'restart']), command: nullable(string(2048))}), 40)}))}),
  answered: object({ok: {type: 'boolean', const: true}, answered: integer()}),
  ok: object({ok: {type: 'boolean', const: true}}),
} as const;

export type Access = 'folder_only' | 'full_access';

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

export interface ParsedResult { ok: boolean; text: string; failureCode: string | null }

export interface Adapter {
  info: AdapterInfo;
  identity(bin: string): Promise<{ ok: boolean; version: string | null }>;
  supports(input: Pick<RunSpec, 'provider' | 'model' | 'effort' | 'access'>): { ok: boolean; reason: string | null };
  build(spec: RunSpec): Invocation;
  parse(result: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; runDir: string }): ParsedResult;
  selfCheck?(stdoutSoFar: string): { mcpServers: string[]; browserTools: string[] } | null;
  agentSetup?(bin: string, folder: string): string[];
}

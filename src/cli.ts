#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightSystemRuntime, SystemRuntimeError } from './system-runtime-preflight.js';
export type { CliOptions } from './cli-main.js';

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  const module = fileURLToPath(import.meta.url);
  try { return resolve(process.argv[1]) === module || realpathSync(process.argv[1]) === module; }
  catch { return false; }
}
const entrypoint = isEntrypoint();
let startupFailure: unknown;
let validation: typeof import('./cli-validation.js') | undefined;
async function loadValidation() {
  // Static application imports would link missing migration modules before
  // preflight, including when a retained bootstrap is imported only to resume.
  await preflightSystemRuntime();
  return import('./cli-validation.js');
}
async function loadCli() {
  if (!validation) throw startupFailure;
  return import('./cli-main.js');
}
async function prepareCli() {
  try {
    validation = await loadValidation();
    if (entrypoint) (await loadCli()).runEntrypoint();
  } catch (error) {
    if (!entrypoint) throw error;
    validation = undefined;
    startupFailure = error;
    process.stderr.write((error instanceof SystemRuntimeError ? error.message : 'The helper operation failed.') + '\n');
    process.exitCode = 1;
  }
}
await prepareCli();
const refused = (): never => { throw startupFailure; };
// Keep the bootstrap importable while migration dependencies are unfinished.
// Invocation still propagates every implementation import or command failure.
export const runCli: typeof import('./cli-main.js').runCli = async (...args) => (await loadCli()).runCli(...args);
export const validateCliLaunch: typeof import('./cli-validation.js').validateCliLaunch = validation?.validateCliLaunch ?? refused;
export const computerName: typeof import('./cli-main.js').computerName = async (...args) => (await loadCli()).computerName(...args);
export const requireRunsPlatform: typeof import('./cli-main.js').requireRunsPlatform = async (...args) => (await loadCli()).requireRunsPlatform(...args);

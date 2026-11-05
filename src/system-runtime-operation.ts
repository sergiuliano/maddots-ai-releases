import { HelperError } from './config.js';
import { systemRuntimeMode } from './system-runtime-preflight.js';

/** Refuse executable-code changes without loading storage or migration code. */
export function assertSystemRuntimeOperation(root: string, operation: string): void {
  if (systemRuntimeMode(root)) throw new HelperError('SYSTEM_RUNTIME_FIXED',
    `The fixed Linux system helper refuses ${operation}. Automatic repair, cached runtimes, update and rollback are disabled; only the founder's root install may change executable code. Retained S5-10 recovery obligations must be resolved before enrollment.`);
}

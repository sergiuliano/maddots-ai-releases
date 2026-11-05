import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import type {LinuxToolLifecycle} from '../../src/runner/process.js';

/** Historical host-HOME and direct-exec controls exercise the Darwin contract. */
export const darwinNativeSkip = process.platform === 'darwin' ? false :
  'Native Darwin fixture: preserves host HOME, installed paths and legacy process cleanup.';

/** Scope a pure platform assertion or simulated process algorithm to one test. */
export function scopedAdapterPlatform(t: TestContext, platform: NodeJS.Platform): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: platform});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

/** Matrix and preparation refusals must precede every containment operation. */
export function refusalLinuxLifecycle(t: TestContext): LinuxToolLifecycle {
  const prepare = t.mock.fn(async () => assert.fail('A refused adapter attempted containment reservation.'));
  const launch = t.mock.fn(async () => assert.fail('A refused adapter attempted workload start.'));
  const cleanup = t.mock.fn(async () => assert.fail('A pre-launch refusal invented a containment run.'));
  t.after(() => {
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(launch.mock.callCount(), 0);
    assert.equal(cleanup.mock.callCount(), 0);
  });
  return {prepare, launch, cleanup};
}

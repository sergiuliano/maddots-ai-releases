import assert from 'node:assert/strict';
import test from 'node:test';
import {waitForNativeFixtureState} from './support/linux-native-workloads.js';

test('native fixture readiness fails immediately when admission has already queued a terminal outcome', {timeout: 1000}, async () => {
  const outcome = {outcome: 'failed', code: 'tool_identity'};
  let polls = 0;
  await assert.rejects(waitForNativeFixtureState(() => {polls++; return false;}, {
    label: 'fixture tool readiness', finished: Promise.resolve(outcome), timeout: 90_000, interval: 60_000,
  }), /fixture tool readiness: run ended.*tool_identity/u);
  assert.equal(polls, 2, 'only one final state observation is allowed after the completed refusal');
});

test('native fixture readiness preserves a startup rejection as its failure cause', {timeout: 1000}, async () => {
  const cause = new Error('fixture startup refused');
  await assert.rejects(waitForNativeFixtureState(() => false, {
    label: 'fixture startup', finished: Promise.reject(cause), timeout: 90_000, interval: 60_000,
  }), error => error instanceof Error && error.cause === cause && /run failed before the expected state/u.test(error.message));
});

test('native fixture readiness accepts a live run before its terminal outcome', {timeout: 1000}, async () => {
  let ready = false;
  setImmediate(() => {ready = true;});
  await waitForNativeFixtureState(() => ready, {
    label: 'fixture live readiness', finished: new Promise(() => {}), timeout: 500, interval: 1,
  });
});

test('native fixture readiness observes a requested terminal state before reporting an early finish', {timeout: 1000}, async () => {
  let queued = false;
  const finished = Promise.resolve().then(() => {queued = true; return {outcome: 'stopped', code: 'TOKEN_REVOKED'};});
  await waitForNativeFixtureState(() => queued, {
    label: 'fixture queued outcome', finished, timeout: 90_000, interval: 60_000,
  });
});

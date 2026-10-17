import {RUNNER_CONSTANTS, RUN_TOKEN_ERROR_CODES} from '../shared/runner-protocol.js';
import {clock, HelperError, type Timing} from '../config.js';
import {MadDotsApiError} from './maddots-api.js';
import type {RunnerOptions} from './runner.js';

type CheckContext = Parameters<NonNullable<RunnerOptions['startCheck']>>[0];

/** TLS-21's startCheck hook. The caller releases it when the outcome is queued. */
export function startTokenCheck({api, claim, stop}: CheckContext, timing: Timing = clock): Promise<() => void> {
  const controller = new AbortController();
  const interval = RUNNER_CONSTANTS.runnerCheckSeconds * 1000;
  const dispose = () => controller.abort();
  const finish = async (code: string) => {
    // Latch before asking the core to stop: cleanup may take time or fail, but
    // a final refusal must never result in another request.
    dispose();
    await stop(code);
  };
  const loop = async () => {
    let next = timing.now() + interval;
    while (!controller.signal.aborted) {
      await timing.sleep(Math.max(0, next - timing.now()), controller.signal);
      if (controller.signal.aborted) return;
      let refusal: string | undefined;
      try {
        const status = await api.check(controller.signal);
        if (status.live !== true || status.runId !== claim.runId || status.cardId !== claim.cardId ||
          status.kind !== claim.kind || Date.parse(status.expiresAt) !== Date.parse(claim.expiresAt)) refusal = 'check_mismatch';
      } catch (error) {
        if (controller.signal.aborted) return;
        // The check route has stricter rules than writes: even a 409 carrying
        // COMMENT_DELIVERY_BUSY is final here. Status wins over the body code.
        if (error instanceof MadDotsApiError && error.status !== undefined &&
          error.status >= 400 && error.status < 500 && error.status !== 429) {
          refusal = Object.hasOwn(RUN_TOKEN_ERROR_CODES, error.code) ? error.code : `HTTP_${error.status}`;
        } else if (error instanceof HelperError && !(error instanceof MadDotsApiError) &&
          ['API_RESPONSE_INVALID', 'API_RESPONSE_TOO_LARGE'].includes(error.code)) refusal = 'check_mismatch';
        // No answer (including an interrupted body), 5xx and 429 leave the
        // tool running. There is no backoff or card re-read for liveness.
      }
      if (controller.signal.aborted) return;
      if (refusal) { await finish(refusal); return; }
      next += interval;
      // Do not overlap requests or burst through missed ticks after suspension.
      if (next <= timing.now()) next = timing.now() + interval;
    }
  };
  // Cancellation and a failed process cleanup must not escape the background
  // task. The core owns the stop reason and durable process-recovery evidence.
  void loop().catch(() => {});
  return Promise.resolve(dispose);
}

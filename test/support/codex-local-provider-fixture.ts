import type {RunnerProtocolClient} from '../../src/runner/protocol-client.js';

/** Synthetic Codex workloads select the local-provider contract explicitly.
 * Their fake adapters never contact a provider or transport a saved login. */
export const CODEX_FIXTURE_PROVIDER = 'ollama';

type FixtureProtocol = Pick<RunnerProtocolClient, 'heartbeat' | 'claim' | 'outcome'>;

/** Preserve real protocol checks while supplying synthetic workload metadata.
 * Server-backed safety fixtures do not exercise saved-login authentication. */
export function codexLocalProviderFixtureProtocol(protocol: FixtureProtocol): FixtureProtocol {
  return {
    heartbeat: async body => {
      const answer = await protocol.heartbeat(body);
      return {...answer, agents: answer.agents.map(agent => ({...agent, provider: CODEX_FIXTURE_PROVIDER}))};
    },
    claim: async body => {
      const answer = await protocol.claim(body);
      return {...answer, claim: {...answer.claim, provider: CODEX_FIXTURE_PROVIDER}};
    },
    outcome: (runId, body) => protocol.outcome(runId, body),
  };
}

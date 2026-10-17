import type { Adapter } from '../adapter.js';
import { codexAdapter } from './codex.js';
import { claudeCodeAdapter } from './claude-code.js';

/** Availability is enforced separately by the matrix's real-tool acceptance gate. */
export class AdapterRegistry {
  readonly #adapters = new Map<string, Adapter>();

  constructor(adapters: Adapter[] = []) { for (const adapter of adapters) this.register(adapter); }

  register(adapter: Adapter): void {
    if (this.#adapters.has(adapter.info.tool) || this.list().some((item) => item.info.harness === adapter.info.harness)) {
      throw new Error('ADAPTER_ALREADY_REGISTERED');
    }
    this.#adapters.set(adapter.info.tool, adapter);
  }

  get(toolOrHarness: string): Adapter | undefined {
    return this.#adapters.get(toolOrHarness) ?? this.list().find((adapter) => adapter.info.harness === toolOrHarness);
  }

  list(): Adapter[] { return [...this.#adapters.values()]; }
}

export const adapters = new AdapterRegistry([codexAdapter, claudeCodeAdapter]);

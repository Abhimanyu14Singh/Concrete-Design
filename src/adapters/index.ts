/**
 * Adapter barrel — registers all import adapters and re-exports the registry.
 *
 * To add a new adapter:
 *   import { EtabsAdapter } from './etabs';
 *   registerAdapter(new EtabsAdapter());
 */

export type { ModelAdapter } from './types';

import type { ModelAdapter } from './types';

const _adapters = new Map<string, ModelAdapter>();

export function registerAdapter(adapter: ModelAdapter): void {
  _adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): ModelAdapter | undefined {
  return _adapters.get(name);
}

export function listAdapters(): string[] {
  return Array.from(_adapters.keys());
}

/**
 * Auto-detect which adapter can handle the given raw data.
 * Returns undefined if no adapter matches — fall back to manual input.
 */
export function detectAdapter(data: unknown): ModelAdapter | undefined {
  for (const adapter of _adapters.values()) {
    if (adapter.canImport(data)) return adapter;
  }
  return undefined;
}

// ── Built-in adapters ─────────────────────────────────────────────────────────
import { EtabsAdapter } from './etabs';
registerAdapter(new EtabsAdapter());

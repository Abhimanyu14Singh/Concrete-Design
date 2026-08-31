/**
 * Engine registry — maps memberType strings to DesignEngine instances.
 *
 * New engines register themselves at startup; the rest of the app calls
 * getEngine(memberType) and never imports engines directly.
 */

import type { DesignEngine } from './types';
import type { BaseLoadCase, BaseDesignResults } from '../types/common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEngine = DesignEngine<any, any, BaseLoadCase, BaseDesignResults>;

const _registry = new Map<string, AnyEngine>();

/** Register an engine under its own `memberType`. Last registration for a type wins. */
export function registerEngine(engine: AnyEngine): void {
  _registry.set(engine.memberType, engine);
}

/** Look up the engine for a member type, or undefined if none is registered. */
export function getEngine(memberType: string): AnyEngine | undefined {
  return _registry.get(memberType);
}

/** Member types that currently have an engine — for diagnostics and UI gating. */
export function listEngines(): string[] {
  return Array.from(_registry.keys());
}

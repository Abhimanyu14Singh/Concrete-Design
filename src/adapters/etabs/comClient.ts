/**
 * ComConnection — renderer-side client for the live CSI OAPI connection.
 *
 * All COM work happens in the Electron main process (electron/etabsBridge.cjs),
 * reached over the context-isolated `window.electronAPI.etabs(method, args)`
 * IPC channel. In the browser (no Electron) construction succeeds but
 * connect() rejects with a clear message so the wizard can offer file import.
 */
import type { ComboForces } from '../../types';
import type {
  EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo,
  EtabsBeamGeom, BeamFilter,
} from './connection';
import { matchesFilter } from './connection';

type EtabsIpc = (method: string, args?: unknown) => Promise<unknown>;

function ipc(): EtabsIpc {
  const api = (window as Window & { electronAPI?: { etabs?: EtabsIpc } }).electronAPI;
  if (!api?.etabs) {
    throw new Error(
      'Live ETABS connection requires the desktop app on Windows with ETABS running. ' +
      'Use "ETABS tables file" import instead.'
    );
  }
  return api.etabs.bind(api);
}

export class ComConnection implements EtabsConnection {
  readonly kind = 'com' as const;
  private beamsCache: EtabsBeamGeom[] | null = null;

  async connect(): Promise<EtabsConnectInfo> {
    return await ipc()('connect') as EtabsConnectInfo;
  }

  async getStories(): Promise<string[]> {
    return await ipc()('getStories') as string[];
  }

  async getGroups(): Promise<string[]> {
    return await ipc()('getGroups') as string[];
  }

  async getFrameSections(): Promise<EtabsSectionInfo[]> {
    return await ipc()('getFrameSections') as EtabsSectionInfo[];
  }

  async getMaterials(): Promise<EtabsMaterialInfo[]> {
    return await ipc()('getMaterials') as EtabsMaterialInfo[];
  }

  async getCombos(): Promise<string[]> {
    return await ipc()('getCombos') as string[];
  }

  async getBeams(filter: BeamFilter): Promise<EtabsBeamGeom[]> {
    // Geometry is fetched once; filtering happens client-side so the wizard's
    // live "N beams match" count doesn't round-trip COM on every checkbox.
    if (!this.beamsCache) {
      this.beamsCache = await ipc()('getBeams') as EtabsBeamGeom[];
    }
    return this.beamsCache.filter(b => matchesFilter(b, filter));
  }

  async getStationForces(frameNames: string[], combos: string[]): Promise<Record<string, ComboForces[]>> {
    return await ipc()('getStationForces', { frameNames, combos }) as Record<string, ComboForces[]>;
  }
}

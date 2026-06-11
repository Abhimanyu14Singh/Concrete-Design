/**
 * Shared visual theme — single source of truth for the palette.
 * Code accents distinguish ACI (blue) from Eurocode (violet) everywhere.
 */

export const CODE_ACCENT: Record<string, string> = {
  'ACI318-19': '#2563eb',
  'ACI318-14': '#2563eb',
  'EN1992-1-1': '#7c3aed',
};

export const CODE_BG: Record<string, string> = {
  'ACI318-19': '#eff6ff',
  'ACI318-14': '#eff6ff',
  'EN1992-1-1': '#f5f3ff',
};

export function codeAccent(code?: string): string {
  return CODE_ACCENT[code ?? ''] ?? '#2563eb';
}
export function codeBg(code?: string): string {
  return CODE_BG[code ?? ''] ?? '#eff6ff';
}

export const DCR = {
  pass: '#16a34a', warn: '#d97706', fail: '#dc2626',
  passBg: '#f0fdf4', warnBg: '#fffbeb', failBg: '#fef2f2',
};

export function dcrColor(d: number): string {
  return d > 1 ? DCR.fail : d > 0.9 ? DCR.warn : DCR.pass;
}
export function dcrBg(d: number): string {
  return d > 1 ? DCR.failBg : d > 0.9 ? DCR.warnBg : DCR.passBg;
}

export const MEMBER_COLOR: Record<string, string> = {
  beam: '#2563eb',
  column: '#7c3aed',
  wall: '#059669',
};

export const BARS = {
  top: '#2e7d32',       // top / compression-face bars
  bot: '#1565c0',       // bottom / tension-face bars
  side: '#8d6e63',      // side / intermediate bars
  tie: '#e91e8c',       // stirrups, ties, spirals
  concrete: '#eceff1',
  concreteEdge: '#546e7a',
};

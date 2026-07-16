/**
 * Shared cell formatters for the group reinforcement schedule — used by BOTH the
 * schedule PDF and the schedule spreadsheet so the two never drift. Top steel is
 * split into its three L/3 regions (mark end / middle third / opposite end),
 * stirrups into their three zones, skin bars carry their spacing, and pinned
 * curtailment notes spell out the specific continuous bar count to keep.
 */
import type { DesignGroup, Member, RebarLayout, BarGroup, DesignCode } from '../../types';
import { formatBarLabel } from '../rebar';
import { getBarArea } from '../concreteDesign';
import { runDesign } from '../../engines';
import { analyzeGroupCurtailment, type FaceCurtailment } from '../curtailment';

/** "n-#b + n-#b" (US) / "n-Øb + …" (EC2). Empty faces render as an em dash. */
export function barsStr(bars?: BarGroup[]): string {
  const active = (bars ?? []).filter(b => b.numBars > 0);
  if (!active.length) return '—';
  return active.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ');
}

/** Skin / side-face bars as "{n}-{size} @ {spacing}", spacing in the code's units. */
export function skinStr(sideBars: BarGroup[] | undefined, isEC2: boolean): string {
  const active = (sideBars ?? []).filter(b => b.numBars > 0);
  if (!active.length) return '—';
  const sp = (v: number) => (isEC2 ? `${(v * 25.4).toFixed(0)} mm` : `${v.toFixed(1)} in`);
  return active.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}${b.spacing ? ` @ ${sp(b.spacing)}` : ''}`).join(' + ');
}

/** One stirrup zone as "{size}-{spacing}-{legs}L". Zone 0/1/2 = end / middle / end;
 *  when no zoned layout is set, all three share `ties.spacing`. */
export function stirrupZoneStr(rebar: RebarLayout, zone: 0 | 1 | 2, isEC2: boolean): string {
  const t = rebar.ties;
  if (!t) return '—';
  const conv = (v: number) => (isEC2 ? (v * 25.4).toFixed(0) : v.toFixed(1));
  const spacing = rebar.tieZones ? rebar.tieZones[zone].spacing : t.spacing;
  return `${formatBarLabel(t.barSize)}-${conv(spacing)}-${t.legs}L`;
}

export function scheduleSectionLabel(m: Member | undefined, isEC2: boolean): string {
  if (!m) return '—';
  const s = m.section;
  const h = s.h ?? s.b;
  return isEC2 ? `${(s.b * 25.4).toFixed(0)}×${(h * 25.4).toFixed(0)}` : `${s.b.toFixed(2)}"×${h.toFixed(2)}"`;
}

/** Fewest bars (≥2) of the face's bar size whose area meets the region's required
 *  As — i.e. how many bars to keep continuous through the curtailment region. */
export function continuousBars(rebar: RebarLayout, face: 'top' | 'bot', fc: FaceCurtailment): string {
  const bars = face === 'top' ? rebar.topBars : rebar.botBars;
  const layer = bars.find(b => b.numBars > 0) ?? bars[0];
  if (!layer) return '—';
  const Ab = getBarArea(layer.barSize);
  const n = Ab > 0 ? Math.max(2, Math.ceil(fc.asRequired / Ab - 1e-6)) : 2;
  return `${n}-${formatBarLabel(layer.barSize)}`;
}

/** Worst DCR across a group's beams (cached results if present, else a design run). */
export function groupMaxDCR(members: Member[], code: DesignCode): number {
  let best = 0;
  for (const m of members) {
    for (const r of m.results ?? []) {
      best = Math.max(best, r.DCR_flex_pos ?? 0, r.DCR_flex_neg ?? 0, r.DCR_shear ?? 0, r.DCR_torsion ?? 0, r.DCR_crack ?? 0);
    }
    if ((m.results?.length ?? 0) === 0) {
      for (const lc of m.loads) {
        try {
          const r = runDesign(m.section, m.material, m.rebar, lc, m.span ?? 20, code, m.crackParams);
          best = Math.max(best, r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion, r.DCR_crack ?? 0);
        } catch { /* skip */ }
      }
    }
  }
  return best;
}

/** Schedule note for a group's PINNED curtailment faces, naming the specific bar
 *  count to keep continuous. Empty string when the group pinned nothing. */
export function groupNoteText(g: DesignGroup, members: Member[], rebar: RebarLayout, code: DesignCode): string {
  if (!g.curtailmentNotes?.top && !g.curtailmentNotes?.bot) return '';
  const cu = analyzeGroupCurtailment(members, rebar, code);
  const parts: string[] = [];
  if (g.curtailmentNotes?.top && cu.top)
    parts.push(`Top: keep ${continuousBars(rebar, 'top', cu.top)} continuous through the middle third (${Math.round(cu.top.pctNeeded)}% req)`);
  if (g.curtailmentNotes?.bot && cu.bot)
    parts.push(`Bottom: keep ${continuousBars(rebar, 'bot', cu.bot)} continuous through the end thirds (${Math.round(cu.bot.pctNeeded)}% req)`);
  return parts.join('; ');
}

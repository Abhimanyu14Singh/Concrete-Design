import type { Member, CrackControlParams, ComboForces } from '../types';
import { DEFAULT_CRACK_PARAMS } from '../types';
import { signedMomentEnvelope } from './autoGroup';

/**
 * Resolve crack-width params for a member under a given design code and the
 * project-level SLS combo. When EC2 is active and an slsCombo is set, the
 * member's quasi-permanent moments are taken from that combo's station-force
 * envelope (kip-ft) and written as Mqp_pos/Mqp_neg overrides; otherwise the
 * existing qpFactor x Mu fallback in the engine applies.
 */
export function resolveCrack(
  member: Member,
  code: string,
  slsCombo?: string,
): CrackControlParams | undefined {
  const cp = member.crackParams;
  if (code !== 'EN1992-1-1') return cp;
  // 1) project-level SLS combo resolved from station forces (preferred)
  if (slsCombo && member.stationForces?.length) {
    const sf: ComboForces[] = member.stationForces.filter(c => c.combo === slsCombo);
    if (sf.length) {
      const env = signedMomentEnvelope(sf); // { maxPos, maxNeg, maxV } in kip-ft/kips
      return { ...(cp ?? DEFAULT_CRACK_PARAMS), Mqp_pos: env.maxPos, Mqp_neg: env.maxNeg };
    }
  }
  // 2) legacy per-member slsLoadCaseId (kept for back-compat)
  if (cp?.slsLoadCaseId) {
    const slsCase = member.loads.find(l => l.id === cp.slsLoadCaseId);
    if (slsCase) return { ...cp, Mqp_pos: slsCase.Mu_pos, Mqp_neg: slsCase.Mu_neg };
  }
  return cp;
}

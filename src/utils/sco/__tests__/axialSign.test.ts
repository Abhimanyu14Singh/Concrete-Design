/**
 * The axial sign convention, written down and defended.
 *
 * Three conventions meet in this app and only two of them agree:
 *
 *   app        `LoadCase.Pu`      COMPRESSION POSITIVE
 *   S-Concrete `Nf` / `N`         COMPRESSION NEGATIVE
 *   ETABS      `Element Forces.P` tension positive (see the caveat below)
 *
 * The app's own convention is not a guess: `computeTorsion`'s `Nu` is documented
 * "POSITIVE = compression", `designMember` splits `DCR_axial` from `DCR_axial_tens`
 * on `Pu >= 0`, and `axialFlexure.test.ts` models S-Concrete's Example 1 — printed
 * "N = −1000.0 kips" under **Max. Axial Comp. Util.** — as `Pu = +1000`.
 *
 * S-Concrete's is read straight off `Examples/ACI/Example 1`: 1000 kips of
 * compression, reported as −1000.0, with ØNn(max) = −1161.7 kips and an axial
 * utilisation of 0.861 that we reproduce.
 *
 * `scoWriterEC2` has negated from the first commit ("Nf = axial (compression
 * NEGATIVE)"). `scoWriterACI` did not, so every axially-loaded ACI beam went to
 * S-Concrete with its axial force REVERSED — a beam designed for compression
 * verified in tension, which moves M_n, V_c and T_cr at once, unconservatively for
 * the compression case. These tests exist so the two writers can never drift again.
 */
import { describe, expect, it } from 'vitest';
import { aciBeamUlsRows } from '../scoWriterACI';
import { ec2BeamUlsRows } from '../scoWriterEC2';
import type { LoadCase, Member } from '../../../types';

const KIP_TO_KN = 4.4482216;
const beam = (loads: LoadCase[]): Member => ({
  id: 'B', label: 'B', memberType: 'beam', span: 20,
  material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
  section: { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 },
  rebar: {
    topBars: [{ numBars: 3, barSize: 8 }], botBars: [{ numBars: 3, barSize: 8 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  },
  loads,
} as Member);
const lc = (Pu: number): LoadCase =>
  ({ id: 'lc', label: 'ULS', Mu_pos: 100, Mu_neg: 0, Vu: 20, Tu: 0, Pu } as LoadCase);
/** Nf is the first numeric cell after the row index. */
const nfOf = (rowText: string) => Number(rowText.split('\t')[1]);

describe('ACI .SCO — Nf is the negative of Pu', () => {
  it('compression (Pu > 0) leaves as a NEGATIVE Nf', () => {
    expect(nfOf(aciBeamUlsRows(beam([lc(1000)]))[0])).toBeCloseTo(-1000, 6);
  });

  it('tension (Pu < 0) leaves as a POSITIVE Nf', () => {
    expect(nfOf(aciBeamUlsRows(beam([lc(-50)]))[0])).toBeCloseTo(50, 6);
  });

  it('zero stays zero, without a signed-zero artefact', () => {
    expect(Math.abs(nfOf(aciBeamUlsRows(beam([lc(0)]))[0]))).toBe(0);
  });

  it('Example 1 round-trips to the number the capture shows', () => {
    // Examples/ACI/Example 1 — 1000 kips compression, S-Concrete prints N = −1000.0.
    expect(nfOf(aciBeamUlsRows(beam([lc(1000)]))[0])).toBeCloseTo(-1000.0, 3);
  });
});

describe('EC2 .SCO — the same convention, in kN', () => {
  it('compression leaves negative', () => {
    expect(nfOf(ec2BeamUlsRows(beam([lc(1000)]))[0])).toBeCloseTo(-1000 * KIP_TO_KN, 2);
  });

  it('tension leaves positive', () => {
    expect(nfOf(ec2BeamUlsRows(beam([lc(-50)]))[0])).toBeCloseTo(50 * KIP_TO_KN, 2);
  });
});

describe('the two writers agree, which is the thing that broke', () => {
  it('ACI and EC2 give Nf the same SIGN for the same load', () => {
    for (const Pu of [1000, 250, -50, -400]) {
      const aci = nfOf(aciBeamUlsRows(beam([lc(Pu)]))[0]);
      const ec2 = nfOf(ec2BeamUlsRows(beam([lc(Pu)]))[0]);
      expect(Math.sign(aci), `Pu = ${Pu}`).toBe(Math.sign(ec2));
      // And both are the opposite of the app's own sign.
      expect(Math.sign(aci), `Pu = ${Pu}`).toBe(-Math.sign(Pu));
    }
  });

  it('the ratio is the unit conversion and nothing else', () => {
    // 4 dp, not more: the 2026 row format writes forces to 3 decimals, so the ratio of
    // two rounded cells cannot carry the constant to full precision.
    const Pu = 137.5;
    expect(nfOf(ec2BeamUlsRows(beam([lc(Pu)]))[0]) / nfOf(aciBeamUlsRows(beam([lc(Pu)]))[0]))
      .toBeCloseTo(KIP_TO_KN, 4);
  });
});

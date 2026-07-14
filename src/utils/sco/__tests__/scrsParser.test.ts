/**
 * Unit tests for the .SCRS parser. The sample below is SYNTHETIC — modeled on
 * the line patterns parse_scrs extracts (Column_Design_DW/compare_all.py). It
 * validates the parse LOGIC; the real S-Concrete layout must be confirmed
 * against an actual .SCRS file.
 */
import { describe, it, expect } from 'vitest';
import { parseScrs } from '../scrsParser';

const SAMPLE = [
  'S-CONCRETE Batch Report',
  '====================================',
  'File: C1_18x18.SCO',
  '  Member designed per ACI 318-19',
  '  OK',
  '  N vs M Util ................ 0.729',
  '  V & T Util ................. 0.410',
  // NOTE: messages are captured only outside a block section. A Msg line after
  // the Shear block would be shadowed by the active block state (faithful to the
  // Python parse_scrs); real .SCRS layout to be confirmed against a sample.
  '  Msg 101 Minimum tie spacing satisfied',
  '  Governing Load Case Utilizations:',
  '    Axial Util. ............. 0.593',
  '    Moment Util. ............ 0.729',
  '    OMn = 165.2',
  '  Maximum Axial Compression Utilization:',
  '    Utilization ............. 0.791',
  '  Maximum Resultant Moment Utilization:',
  '    Utilization ............. 0.729',
  '  Shear and Torsion Utilization:',
  '    phi_Vnz = 95.3',
  '    phi_Vny = 88.1',
  '    phi_Tcr = 42.0',
  '====================================',
  'File: C2_24x24.SCO',
  '  OVERSTRESSED',
  '  N vs M Util ................ 1.150',
  '  V & T Util ................. 0.266',
  '  Msg 207 Longitudinal steel exceeds 8%',
  '====================================',
].join('\n');

describe('parseScrs', () => {
  const out = parseScrs(SAMPLE);

  it('splits one result per File: section', () => {
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.name)).toEqual(['C1_18x18', 'C2_24x24']);
  });

  it('extracts status, summary, governing, max, and shear values for section 1', () => {
    const r = out[0];
    expect(r.status).toBe('OK');
    expect(r.nmUtil).toBeCloseTo(0.729, 6);
    expect(r.vtUtil).toBeCloseTo(0.41, 6);
    expect(r.axialUtil).toBeCloseTo(0.593, 6);
    expect(r.momentUtil).toBeCloseTo(0.729, 6);
    expect(r.phiMn).toBeCloseTo(165.2, 6);
    expect(r.maxAxialUtil).toBeCloseTo(0.791, 6);
    expect(r.maxMomentUtil).toBeCloseTo(0.729, 6);
    expect(r.phiVnz).toBeCloseTo(95.3, 6);
    expect(r.phiVny).toBeCloseTo(88.1, 6);
    expect(r.phiTcr).toBeCloseTo(42.0, 6);
    expect(r.msgs).toEqual(['Msg 101 Minimum tie spacing satisfied']);
  });

  it('handles an overstressed section with only summary lines', () => {
    const r = out[1];
    expect(r.status).toBe('OVERSTRESSED');
    expect(r.nmUtil).toBeCloseTo(1.15, 6);
    expect(r.vtUtil).toBeCloseTo(0.266, 6);
    expect(r.axialUtil).toBeNull();
    expect(r.msgs).toEqual(['Msg 207 Longitudinal steel exceeds 8%']);
  });

  it('returns an empty array for input with no File: sections', () => {
    expect(parseScrs('no sections here\njust text')).toEqual([]);
  });
});

// Real S-Concrete 2026 EN 1992 layout (tab-separated Summary + a "List of
// Messages:" block), taken verbatim from an actual .SCRS batch report.
const EC2_SAMPLE = [
  '################################################################################',
  'File:\tStory2_ConcBm1.SCO',
  'Section Name:\tStory2 · ConcBm1',
  'Summary:',
  '\tStatus        \tBorderline',
  '\tMaximum       \t1.000',
  '\tV & T Util    \t0.612',
  '\tN vs M Util   \t1.054',
  '##############################',
  'N vs M Results:',
  '\tStatus     \tBorderline (Message 1)',   // per-check status must NOT override the summary
  '\tUtilization\t1.054',
  '##############################',
  'List of Messages:',
  '\tMessage 1      \tBorderline     \tAxial Load and Moment Utilization equals or exceeds Maximum.',
  '\t               \t               \tClause 6.1 of EN 1992-1-1',
  '\tMessage 2      \tWarning        \tArea of Steel provided does not meet the Minimum.',
  '\t               \t               \tClause 9.2.1.1(1) of EN 1992-1-1',
  '##############################',
].join('\n');

describe('parseScrs — real S-Concrete EN 1992 layout', () => {
  const [r] = parseScrs(EC2_SAMPLE);

  it('reads the Summary status and tab-separated utilizations', () => {
    expect(r.name).toBe('Story2_ConcBm1');
    expect(r.status).toBe('Borderline');           // the SUMMARY status, not a per-check one
    expect(r.nmUtil).toBeCloseTo(1.054, 6);
    expect(r.vtUtil).toBeCloseTo(0.612, 6);
  });

  it('extracts each List-of-Messages entry with its severity, text and clause', () => {
    expect(r.msgs).toHaveLength(2);
    expect(r.msgs[0]).toBe('Borderline: Axial Load and Moment Utilization equals or exceeds Maximum. (Clause 6.1 of EN 1992-1-1)');
    expect(r.msgs[1]).toContain('Warning: Area of Steel provided does not meet the Minimum.');
    expect(r.msgs[1]).toContain('Clause 9.2.1.1(1)');
  });
});

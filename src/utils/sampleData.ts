import type { Project } from '../types';
import { defaultSettings } from './projectSettings';

export const defaultProject: Project = {
  id: 'proj-001',
  name: 'Office Building Frame',
  code: 'ACI318-19',
  description: 'Reinforced concrete frame design',
  engineer: 'A. Singh, PE',
  date: new Date().toLocaleDateString(),
  // Stock ACI standards — what the setup dialog opens on for a first run, and
  // what the sample beam B1 below is already built to. The dialog writes the
  // engineer's own values over these (and over every member) on save.
  settings: defaultSettings('ACI318-19'),
  members: [
    {
      id: 'B1',
      label: 'Beam B1 - Grid A/1-3',
      memberType: 'beam',
      span: 24,
      material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
      section: {
        type: 'rectangular_beam',
        b: 16,
        h: 24,
        coverClear: 1.5,
        stirrupDia: 4,
      },
      rebar: {
        topBars: [{ numBars: 3, barSize: 8 }],
        botBars: [{ numBars: 4, barSize: 8 }],
        ties: { barSize: 4, spacing: 6, legs: 2 },
      },
      loads: [
        { id: '1.2D+1.6L', label: '1.2D + 1.6L', Mu_pos: 185, Mu_neg: 142, Vu: 68, Tu: 8, Pu: 0 },
        { id: '1.4D', label: '1.4D', Mu_pos: 145, Mu_neg: 110, Vu: 52, Tu: 4, Pu: 0 },
        { id: '1.2D+1.0E', label: '1.2D + 1.0E', Mu_pos: 160, Mu_neg: 135, Vu: 75, Tu: 6, Pu: 0 },
      ],
    },
    {
      id: 'B2',
      label: 'Beam B2 - Grid B/2-4 (T-Beam)',
      memberType: 'beam',
      span: 30,
      material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
      section: {
        type: 'T_beam',
        b: 48,
        bw: 14,
        h: 28,
        hf: 5,
        coverClear: 1.5,
        stirrupDia: 4,
      },
      rebar: {
        topBars: [{ numBars: 3, barSize: 9 }],
        botBars: [{ numBars: 5, barSize: 9 }],
        ties: { barSize: 4, spacing: 5, legs: 2 },
      },
      loads: [
        { id: '1.2D+1.6L', label: '1.2D + 1.6L', Mu_pos: 320, Mu_neg: 210, Vu: 95, Tu: 12, Pu: 0 },
        { id: '1.4D', label: '1.4D', Mu_pos: 240, Mu_neg: 165, Vu: 72, Tu: 6, Pu: 0 },
      ],
    },
  ],
};

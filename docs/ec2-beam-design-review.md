# EN 1992-1-1 (Eurocode 2) Beam Design — Engineering Review

**Audience:** Senior/chartered structural engineer.
**Purpose:** Verify the engineering logic, formulas, clause references, assumptions, and unit handling of the EC2 beam checks as currently implemented.
**Primary source:** `src/engines/ec2/ec2Beam.ts` (line refs cited as `ec2Beam.ts:NNN`).
**Supporting:** `src/utils/calcBreakdownEC2.ts` (calc-sheet renderer), `src/utils/concreteDesign.ts` (shared `ZoneShearResult` type + ACI zoned-shear mirror), `src/components/Results/MemberResults.tsx` and `src/components/Detailing/ForceDiagram.tsx` (zoned-shear dispatch), `src/types/index.ts`.

---

## 1. Overview & scope

The engine designs/checks rectangular and T/L beams to EN 1992-1-1 for:

- **Flexure** §6.1 — M_Rd (singly reinforced; T/L flange split), ductility x/d.
- **Shear** §6.2 — V_Rd,c, V_Rd,s, V_Rd,max, variable-strut truss, zoned (per-third) shear.
- **Torsion** §6.3 — thin-walled tube, T_Rd,c / T_Rd,s / T_Rd,max, longitudinal + transverse steel demand, combined V+T.
- **Crack control / SLS** §7.3 — wk for bottom/top/side faces under the quasi-permanent combination.
- **Detailing** §8.2, §9.2 — As,min/As,max, bar clear spacing, stirrup spacing limits, ρw,min.

### Boundary convention (`ec2Beam.ts:1–16`, `256–283`, `558–583`)

The application stores **imperial** data (in, psi, kips, kip-ft). `designMemberEC2()` converts to SI **at the boundary**, runs every check in **mm / MPa / kN / kN·m**, then converts results back to imperial so the shared `DesignResults` display pipeline is unchanged.

### No φ factor — safety is in material partial factors (`ec2Beam.ts:9–13`, `33–37`, `277–279`)

EC2 carries **no strength-reduction φ**. Safety lives in:

- γ_c = 1.5, γ_s = 1.15 (Table 2.1N) → `GAMMA_C`, `GAMMA_S`.
- α_cc = **0.85** (`ALPHA_CC`) — this is the **UK National Annex** value; base EN 1992-1-1 recommends 1.0.

Design strengths: `fcd = αcc·fck/γc`, `fyd = fyk/γs`, `fywd = fywk/γs` (`ec2Beam.ts:277–279`).

The returned `phi_Mn`/`phi_Vn`/`phi_Tn` fields hold the **design resistances** (M_Rd, V_Rd, T_Rd) — no φ is applied. `Mn_* === phi_Mn_*` by construction (`ec2Beam.ts:566–570`).

### f'c interpretation (`ec2Beam.ts:15`, `274`)

The stored `material.fc` (psi) is treated as a **cylinder** strength: `fck = fc × 0.00689476 MPa`. No cube/cylinder conversion is applied.

### National Annex assumptions baked in

| Quantity | Value used | Source |
|---|---|---|
| α_cc | 0.85 | UK NA (`ec2Beam.ts:37`) |
| C_Rd,c | 0.18/γc | recommended (`ec2Beam.ts:92`) |
| k1 (V_Rd,c axial) | 0.15 | recommended (`ec2Beam.ts:93`) |
| ν_min | 0.035·k^1.5·√fck | recommended (`ec2Beam.ts:95`) |
| cot θ | 2.5 (fixed) | NA upper bound (`ec2Beam.ts:312`, etc.) |
| α_cw | 1.0 (non-prestressed) | `ec2Beam.ts:114`, `153` |

---

## 2. Units & conversions (`ec2Beam.ts:27–31`)

| Constant | Value | Use |
|---|---|---|
| `IN_TO_MM` | 25.4 | length |
| `PSI_TO_MPA` | 0.00689476 | stress (fck, fyk, fywk, Es) |
| `KIP_TO_KN` | 4.44822 | force (V, axial) |
| `KIPFT_TO_KNM` | 1.35582 | moment / torsion |
| `IN2_TO_MM2` | 645.16 | steel area |

Same constants are duplicated in `calcBreakdownEC2.ts:14`.

---

## 3. Flexure (§6.1)

### Stress-block factors λ, η — §3.1.7 (`ec2Beam.ts:40–44`)

- λ = 0.8 (fck ≤ 50), else 0.8 − (fck−50)/400
- η = 1.0 (fck ≤ 50), else 1.0 − (fck−50)/200

### M_Rd — `mRd()` (`ec2Beam.ts:57–79`)

Rectangular (or full flange width) neutral axis:

- **x = As·fyd / (η·fcd·λ·b)** (`ec2Beam.ts:65`)
- **M_Rd = As·fyd·(d − λx/2)** /1e6 → kN·m (`ec2Beam.ts:77`)

**T/L flange split** (triggered when `bw`, `hf` given and `λx > hf` and `bw < b`, `ec2Beam.ts:67–75`):

- Flange overhang force: F_f = η·fcd·(b−bw)·hf
- Web force: F_w = As·fyd − F_f
- Web block depth: a_w = F_w / (η·fcd·bw); x = (hf + a_w)/λ
- M_Rd = F_f·(d − hf/2) + F_w·(d − hf − a_w/2)

Dispatch (`ec2Beam.ts:296–299`): positive moment uses flange width `bf_mm` and the split when `type ∈ {T_beam, L_beam}`; negative moment always uses web width `b_mm` (flange in tension).

### Ductility check — x/d ≤ 0.45 (`ec2Beam.ts:304–306`)

Warning only (severity `warning`), keyed "EC2 §5.5". Applied to the **positive** section only; checks `pos.x/d_bot > 0.45`.

---

## 4. Shear (§6.2)

### V_Rd,c — no shear reinforcement, §6.2.2 eq (6.2a/b) (`vRdc`, `ec2Beam.ts:86–99`)

- k = min(2.0, 1 + √(200/d))
- ρ_l = min(0.02, Asl/(bw·d))
- C_Rd,c = 0.18/γc; k1 = 0.15
- σ_cp = min(N_Ed/A_c, 0.2·αcc·fck/γc) — only when A_c > 0
- v1 = C_Rd,c·k·(100·ρl·fck)^⅓ + k1·σ_cp  (eq 6.2a)
- v2 = ν_min + k1·σ_cp, with ν_min = 0.035·k^1.5·√fck  (eq 6.2b floor)
- **V_Rd,c = max(v1, v2)·bw·d** → kN

### V_Rd,s — stirrups, §6.2.3 eq (6.8) (`vRds`, `ec2Beam.ts:102–107`)

**V_Rd,s = (Asw/s)·z·fywd·cotθ**, with z = 0.9d (`ec2Beam.ts:311`) and cotθ = 2.5 (`ec2Beam.ts:312`).

### V_Rd,max — strut crushing, §6.2.3 eq (6.9) (`vRdMax`, `ec2Beam.ts:110–117`)

- ν1 = 0.6·(1 − fck/250)
- α_cw = 1.0
- **V_Rd,max = α_cw·bw·z·ν1·fcd / (cotθ + tanθ)** → kN

### Combination (`ec2Beam.ts:329`)

- With stirrups: **V_Rd = min(V_Rd,s, V_Rd,max)**.
- Without stirrups: **V_Rd = V_Rd,c**.

### Strut-crushing warning logic (`ec2Beam.ts:332–336`)

A strut-crushing **error** is raised only when **V_Ed > V_Rd,max** (a genuine failure). Over-provided links (V_Rd,s > V_Rd,max but V_Rd,max ≥ V_Ed) are not flagged — design is still adequate.

### Zoned shear behaviour — `zonedShearCheckEC2()` (`ec2Beam.ts:593–632`)

When `rebar.tieZones` (three spacings over equal thirds [end, middle, end]) are present, per-third DCRs are computed. **This now uses EC2 variable-strut formulas** (mirrors the ACI `zonedShearCheck` shape but replaces the ACI §22.5 model):

For each zone i: V_Rd,s,i = `vRds(Asw, s_i, z, fywd, 2.5)`; V_Rd,max = `vRdMax(...)`; capacity = **min(V_Rd,s,i, V_Rd,max)**; DCR = Vu_i / capacity (Vu_i in kips, capacity converted to kips). Returns `ZoneShearResult[]` (`concreteDesign.ts:340–346`).

**Dispatch by code:** Both `MemberResults.tsx:69–80` and `ForceDiagram.tsx:74–83` route to `zonedShearCheckEC2` when `code === 'EN1992-1-1'`, else to the ACI `zonedShearCheck`. `zoneShearDemands` (per-third max |V|) is shared from `concreteDesign.ts:12–22`.

### Worst-zone headline fix (`ec2Beam.ts:318–324`)

The headline `DCR_shear` (the single value shown on the results panel) now uses the **worst (widest) tie-zone spacing** when zones are present:

```
worstSpacing = tieZones ? max(zone.spacing) : ties.spacing
```

V_Rd,s for the headline is computed at `worstSpacing`, so the headline capacity reflects the least-reinforced third rather than the tightest end-zone spacing stored in `ties.spacing`. (Note: torsion and detailing checks below still use the bare `ties.spacing` — see reviewer flags.)

### Required transverse steel (`ec2Beam.ts:579–580`)

`Av_req = V_Ed/(z·fywd·cotθ)` once V_Ed > V_Rd,c (full truss, no concrete term added — unlike ACI). `Av_min/s` reported from ρw,min·bw. These imperial-equivalent fields are **not shown** for EC2 in the UI (`MemberResults.tsx:403–406`).

---

## 5. Torsion (§6.3) — `tRd()` (`ec2Beam.ts:124–162`)

Solid rectangle → equivalent thin-walled closed tube, §6.3.2.

- Gross A = b·h, outer perimeter u = 2(b+h).
- **Wall thickness:** distinguishes cracking vs truss (`ec2Beam.ts:131–137`):
  - cracking: `tef_c = min(A/u, min(b,h)/2)`
  - truss: `tef = min(max(A/u, 2·coverToCentre), min(b,h)/2)` — applies the §6.3.2(1) 2×(surface-to-bar-centroid) floor.
  - `coverToCentre = cover + Østirrup + Øbar/2` (`ec2Beam.ts:347`).
- A_k, u_k from the relevant wall (cracking uses A_kc with tef_c; truss uses A_k, u_k with tef).

Resistances:

- **T_Rd,s = 2·A_k·(Asw_leg/s)·fywd·cotθ** (one leg effective) (`ec2Beam.ts:145–147`).
- **T_Rd,max = 2·ν·α_cw·fcd·A_k·tef·sinθ·cosθ**, eq (6.30); ν = 0.6(1−fck/250), α_cw = 1.0, θ = atan(1/cotθ) (`ec2Beam.ts:152–155`). fcd already carries α_cc; not double-counted.
- **T_Rd,c = 2·A_kc·tef_c·fctd**, §6.3.2(5); fctd = 0.7·fctm/γc (≈ αct·fctk,0.05/γc) (`ec2Beam.ts:158–159`).

Member-level (`ec2Beam.ts:338–386`):

- T_Rd = min(T_Rd,s, T_Rd,max) (`ec2Beam.ts:352`).
- **Longitudinal torsion steel**, §6.3.2(3) eq (6.28): ΣAsl = T_Ed·cotθ·u_k / (2·A_k·fyd), computed only when T_Ed > T_Rd,c (`ec2Beam.ts:359–361`). A per-chord share (ΣAsl/4) is added to flexural longitudinal demand (`ec2Beam.ts:391–393`).
- **Combined V+T transverse demand** (`ec2Beam.ts:363–372`): per-leg torsion link demand `T_Ed/(2·A_k·fywd·cotθ)` **adds** to the per-leg shear link demand `V_Ed/(nLegs·z·fywd·cotθ)`; compared to provided Asw/s per leg → error if exceeded.
- **Combined V+T interaction** §6.3.2(4) eq (6.29) (`ec2Beam.ts:381–386`): T_Ed/T_Rd,max + V_Ed/V_Rd,max ≤ 1.0; error if > 1.

**Torsion uses bare `ties.spacing`** (`ec2Beam.ts:350`), not the worst-zone spacing.

### DCR_torsion (`ec2Beam.ts:531–533`)

- T_Ed ≤ T_Rd,c → DCR = T_Ed/T_Rd,c (utilization of concrete cracking resistance).
- T_Ed > T_Rd,c → DCR = T_Ed/T_Rd (utilization of full truss resistance).

---

## 6. Crack control / SLS (§7.3) — `crackWidth()` (`ec2Beam.ts:186–248`)

Quasi-permanent combination. Constants: k1 = 0.8 (ribbed), k3 = 3.4, k4 = 0.425; k2 computed (see below).

**Quasi-permanent moment** (`ec2Beam.ts:478–479`): explicit `Mqp_pos/neg` (kip-ft) if supplied via SLS load case, else `qpFactor × M_Ed` (default qpFactor = 0.6).

Procedure:

1. α_e = Es/Ecm; Ecm = 22000·((fck+8)/10)^0.3 (§3.1.3) (`ec2Beam.ts:167–169`, `202`).
2. **Cracked elastic NA:** b·x²/2 = α_e·As·(d−x) solved as x = n(√(1+2d/n) − 1), n = α_e·As/b (`ec2Beam.ts:205–206`).
3. Lever arm z = d − x/3; **σs = Mqp/(As·z)** (`ec2Beam.ts:207–208`).
4. **Effective tension area** §7.3.2(3): hc,ef = min(2.5(h−d), (h−x)/3, h/2); Ac,eff = b·hc,ef; **ρp,eff = As/Ac,eff** (`ec2Beam.ts:211–213`).
5. **k2** (`ec2Beam.ts:223–225`): general form k2 = (a1 + max(a2,0))/(2·a1) where a1 = h−x, a2 = a1 − hc,ef. Reduces to 0.5 for pure bending, 1.0 for pure tension. More conservative than the EC2 simplified 0.5 when hc,ef is deep. *(Deviation from the textbook 0.5 — see flags.)*
6. **sr,max** (`ec2Beam.ts:230–238`): bar spacing = (b − 2c − Ø)/(nBars−1); threshold = 5(c + Ø/2).
   - spacing ≤ threshold → eq (7.11): **sr,max = k3·c + k1·k2·k4·Ø/ρp,eff**
   - spacing > threshold → eq (7.14): **sr,max = 1.3·(h−x)**
   - which one governed is reported (`srEq`).
7. **εsm − εcm**, eq (7.9): max([σs − kt·(fct_eff/ρp,eff)·(1+α_e·ρp,eff)]/Es, 0.6·σs/Es); fct_eff = fctm; kt = 0.4 (long) / 0.6 (short) (`ec2Beam.ts:240–245`).
8. **wk = sr,max·(εsm − εcm)** (`ec2Beam.ts:247`).

### Bottom / top faces (`ec2Beam.ts:481–491`)

Bottom uses As_bot + bottom bar Ø under Mqp_pos; top uses As_top + top bar Ø under Mqp_neg. Cover passed is `cover + Østirrup`. Limits `wLimitBot`, `wLimitTop` (default 0.30 mm).

### Side face — approximate (`ec2Beam.ts:493–523`)

Only when side bars exist and governing Mqp > 0:

- **As_side** = total skin-bar area; **sideBarD** = skin-bar diameter (now used consistently — *recent fix*).
- A reference strain is derived by calling `crackWidth()` with the **governing main-chord moment** but the **side-bar geometry** (As_side, sideBarD) at the governing effective depth.
- **hc_side = min(2.5·(c + Østirrup + Øskin/2), h/2)** (`ec2Beam.ts:511`) — the spurious extra `×2` multiplier was **removed**; coefficient is now `2.5·(c + φ_link + φ_skin/2)` per §7.3.2.
- ρ_side = As_side/(b·hc_side); sr_side = k3·(c+Østirrup) + k1·k2·k4·Øskin/ρ_side with k2 fixed at 0.5 here.
- ε_side = wk_main/sr_max,main (chord strain); **wk_face = sr_side·ε_side**. Warning vs `wLimitFace` (default 0.30 mm), severity `warning`.
- If no side bars and h > 1000 mm → skin-reinforcement-required warning (§7.3.3).

**Conservatism / approximation:** side bars are assumed to carry the same steel strain as the main tension chord, and ρp,eff is over a strip between bars and face. This is an engineering approximation, not a literal EC2 clause — flagged below.

---

## 7. DCRs & status logic (`ec2Beam.ts:525–556`)

| DCR | Formula | Source |
|---|---|---|
| DCR_flex_pos | M_Ed,pos / M_Rd_pos | `ec2Beam.ts:526` |
| DCR_flex_neg | M_Ed,neg / M_Rd_neg | `ec2Beam.ts:527` |
| DCR_shear | V_Ed / V_Rd (V_Rd at worst-zone spacing) | `ec2Beam.ts:528` |
| DCR_torsion | T_Ed/T_Rd,c (≤ cracking) or T_Ed/T_Rd (> cracking) | `ec2Beam.ts:531–533` |
| DCR_crack | max over faces of wk/w_limit | `ec2Beam.ts:545–549` |

When a capacity is zero but demand > 0, DCR = Infinity (e.g. flexure/shear `ec2Beam.ts:526–528`).

**maxDCR** = max of the five (`ec2Beam.ts:551`).

**Status** (`ec2Beam.ts:552–556`): `NG` if maxDCR > 1; else `Warning` if any warning message exists; else `OK`. So a section can be at high passing utilization and still report OK if no clause warning fired.

---

## 8. Assumptions, simplifications & reviewer flags

1. **Fixed cotθ = 2.5 everywhere** (`ec2Beam.ts:312`, `609`, default arg in `vRds`/`vRdMax`/`tRd`). No optimisation between 1.0 and 2.5, and no check that the chosen θ is consistent with V_Rd,s ≤ V_Rd,max. Using cotθ = 2.5 maximises V_Rd,s but minimises V_Rd,max; the min() handles capacity but **longitudinal tension-shift steel and stirrup demand are computed at the same fixed angle** — reviewer should confirm the angle assumption suits the member.

2. **α_cc = 0.85 (UK NA), γ values 1.5/1.15** are hardcoded (`ec2Beam.ts:34–37`). No National-Annex switch. C_Rd,c, k1, ν_min also use recommended values.

3. **f'c = cylinder fck** with a single 0.00689476 factor (`ec2Beam.ts:15`, `274`). No cube-strength path; if users enter cube values the results are unconservative.

4. **Headline shear uses worst-zone spacing, but torsion + detailing still use `ties.spacing`** (`ec2Beam.ts:350`, `469`). The combined V+T transverse check (`ec2Beam.ts:363–372`) and ρw,min/s_max checks therefore reflect the **stored** spacing, which may be the tight end zone, not the worst zone used for the headline shear DCR. Potential inconsistency between the headline shear DCR and the V+T link adequacy / spacing warnings when zones are present.

5. **k2 in crack width uses the general (a1+a2)/2a1 form, not the EC2 simplified 0.5** (`ec2Beam.ts:215–225`). Stated to match S-CONCRETE and be more conservative for deep effective-tension strips. A reviewer who expects literal §7.3.4 k2 = 0.5 for bending should note this deviation.

6. **Side-face crack width is an approximation** (`ec2Beam.ts:493–519`): equal-strain assumption to the main chord, k2 fixed at 0.5, ρp,eff over a face strip. Not a verbatim EC2 calculation; intended as conservative skin-bar screening. The reference strain is obtained by calling `crackWidth()` with the main-chord moment but side-bar geometry, which is a modelling choice rather than a code procedure.

7. **Ductility check x/d ≤ 0.45 is positive-moment only and warning-only** (`ec2Beam.ts:304–306`). The negative section is not checked, and exceeding 0.45 does not down-rate capacity (no moment-redistribution coupling).

8. **As,min basis** §9.2.1.1: max(0.26·fctm/fyk, 0.0013)·bw·d using **bw (web width)** and **d_bot** for both faces (`ec2Beam.ts:397`). EC2 uses bt (mean tension-zone width) — for T-beams in sagging this could differ. As,max = 0.04·Ac with Ac = bw·h (`ec2Beam.ts:398`).

9. **z = 0.9d fixed** for shear and torsion-longitudinal lever arms (`ec2Beam.ts:311`, `390`) — standard simplification but not derived from the actual flexural lever arm.

10. **σ_cp axial term** in V_Rd,c only active when Ac passed (`ec2Beam.ts:94`); always passed as bw·h. Sign convention: N_Ed compression positive.

11. **Aggregate size dg = 20 mm assumed** for §8.2 clear-spacing check (`ec2Beam.ts:411`); k1 = 1, k2 = 5 mm recommended values.

12. **Shear tension-shift longitudinal steel §6.2.3(7) is intentionally excluded** (`ec2Beam.ts:388–389`) despite the returned-field comment at `ec2Beam.ts:571` mentioning "shear tension shift (eq 6.18)". **The comment is misleading** — `AsLongReqBot/Top` (`ec2Beam.ts:391–393`) include only flexure + torsion longitudinal share, **not** a tension-shift term. Reviewer flag: comment/implementation mismatch.

13. **Calc sheet uses bare `ties.spacing` and no zones** (`calcBreakdownEC2.ts:97–110`) and computes V_Rd,c with `vRdc(b,d,As,fck)` omitting the axial σ_cp term that the member check includes — minor inconsistency between the calc sheet and the governing engine when axial load is present.

14. **Torsion calc-sheet `tRd` call omits `coverToCentre`** (`calcBreakdownEC2.ts:117`, default 0), so the displayed tef/Ak use the bare A/u wall, whereas the member check applies the 2×cover floor. The calc sheet can therefore show different torsion numbers than the governing check.

15. **Single-layer effective depth**: d_bot/d_top computed from the **first** bar group only (`ec2Beam.ts:283–287`); multi-layer centroid (available in `concreteDesign.ts`) is not used in the EC2 path.

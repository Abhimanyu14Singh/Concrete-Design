// Pushing resized groups back to ETABS — the pure half.
//
// Everything here is data in, data out: which groups have been resized since the model
// was imported, what ETABS frame-section property each one needs, and what the new model
// should be called. No React, no state, no side effects — so the dialog can render it and
// a check can assert it without either standing the other up.
//
// ── What this is, honestly ─────────────────────────────────────────────────────
// The demo has no ETABS. The app's EtabsConnection is READ-ONLY today — connect,
// getBeams, getStationForces, getFrameSections, getMaterials, and a pushGroups that
// assigns group MEMBERSHIP and nothing else. Creating a frame-section property,
// assigning it to frames, File→Save As and Analyze→Run all need COM calls that do not
// exist in `src/adapters/etabs/`, in `electron/etabsBridge.cjs`, or in the EtabsHelper
// sidecar.
//
// So `applyPush` below does NOT write to ETABS. It builds exactly the payload such a
// write would take, and produces the design results the re-run would come back with, by
// running the app's own engine over the resized model. That is the whole round trip
// except the transport — and the transport is one function away, which is why the payload
// is built here in the shape the COM calls want rather than in whatever shape the dialog
// found convenient.

/** Section identity for comparison — the two dimensions an ETABS beam property carries,
 *  plus the concrete grade, which is part of the property in ETABS and part of why a
 *  resized group needs a NEW property rather than an edit to the old one. */
const sectionKey = m => `${m.section.bw ?? m.section.b}x${m.section.h}|${Math.round(m.material.fc)}`

/** `B16X32-C5000` — ETABS property names are free text, but a name that states the two
 *  dimensions and the grade is the one an engineer can read off a schedule without
 *  opening the section. Dimensions are the STORED (imperial) values, because that is what
 *  the model was built in; the display unit system is a viewing preference and must not
 *  rename a property in the file. */
export function defaultPropertyName(member) {
  const b = Math.round(member.section.bw ?? member.section.b)
  const h = Math.round(member.section.h)
  return `B${b}X${h}-C${Math.round(member.material.fc)}`
}

/** `Demo frame — A–F / 1–8` → `Demo frame — A–F / 1–8_rev2.EDB`. Kept as a suggestion the
 *  user edits: naming a revision is a decision about their filing, not ours. */
export function defaultModelName(baseName, revision) {
  const stem = String(baseName || 'model').replace(/\.(EDB|edb)$/, '')
  return `${stem}_rev${revision}.EDB`
}

/**
 * Which groups have been RESIZED since the baseline, and what each one now needs.
 *
 * "Resized" is judged per member against that member's own baseline section, not against
 * the group's — a beam moved into a group adopts the group's geometry, and that is a real
 * change to that beam even though the group's representative never moved.
 *
 * The representative is the group's GOVERNING beam, matching how the rest of the app
 * picks one (the dashboard card, the group-move donor): it is the beam the group is
 * actually detailed for, so it is the one whose section the new property should carry.
 */
export function resizedGroups(groups, current, baseline) {
  const cur = new Map(current.map(m => [m.id, m]))
  const base = new Map(baseline.map(m => [m.id, m]))
  const out = []

  for (const g of groups) {
    const members = g.memberIds.map(id => cur.get(id)).filter(Boolean)
    if (!members.length) continue

    const changed = members.filter(m => {
      const b = base.get(m.id)
      return b && sectionKey(m) !== sectionKey(b)
    })
    if (!changed.length) continue

    // Representative = worst DCR among the group's members, when the caller supplies
    // DCRs; otherwise the first changed member. Falling back rather than requiring the
    // DCRs keeps this callable from a test that has no engine run behind it.
    const rep = changed.reduce(
      (a, m) => ((g.dcrById?.[m.id] ?? 0) > (g.dcrById?.[a.id] ?? 0) ? m : a),
      changed[0],
    )
    const from = base.get(rep.id)

    out.push({
      groupId: g.id,
      label: g.label,
      color: g.color,
      memberCount: members.length,
      changedCount: changed.length,
      from: { b: from.section.bw ?? from.section.b, h: from.section.h, fc: from.material.fc },
      to: { b: rep.section.bw ?? rep.section.b, h: rep.section.h, fc: rep.material.fc },
      propertyName: defaultPropertyName(rep),
      // The frames ETABS would reassign. Frame name, not member id — that is what the
      // COM call takes, and the two are only the same string by accident in this model.
      frameNames: members.map(m => m.etabs?.frameName || m.id),
    })
  }
  return out
}

/**
 * The payload the four COM calls would take, in their order.
 *
 * Written out even though nothing consumes it yet, because it is the part that has to be
 * RIGHT when the sidecar lands: one DefineFrameSection per distinct property, one
 * AssignSection per group, then SaveAs and RunAnalysis. Two groups that resized to the
 * same section and grade share one property — ETABS would reject the second definition,
 * and an engineer reading the schedule should not find B16X32-C5000 twice.
 */
export function buildPushPayload(rows, modelName) {
  const byProperty = new Map()
  for (const r of rows) {
    const p = byProperty.get(r.propertyName) || { name: r.propertyName, b: r.to.b, h: r.to.h, fc: r.to.fc, frameNames: [] }
    p.frameNames.push(...r.frameNames)
    byProperty.set(r.propertyName, p)
  }
  const properties = [...byProperty.values()].map(p => ({
    ...p, frameNames: [...new Set(p.frameNames)],
  }))
  return {
    defineFrameSections: properties.map(({ name, b, h, fc }) => ({ name, b, h, fc })),
    assignSections: properties.map(({ name, frameNames }) => ({ name, frameNames })),
    saveAs: modelName,
    runAnalysis: true,
    frameCount: properties.reduce((n, p) => n + p.frameNames.length, 0),
  }
}

/** Names must be present and distinct, or ETABS would silently collapse two properties
 *  into one and half the frames would end up on the wrong section. Checked here so the
 *  dialog can disable its button for the same reason it would fail. */
export function validatePush(rows, modelName) {
  const errors = []
  if (!String(modelName || '').trim()) errors.push('Give the new model a name.')
  const names = rows.map(r => String(r.propertyName || '').trim())
  if (names.some(n => !n)) errors.push('Every resized group needs a frame-property name.')
  // Duplicates are only a problem when the SECTIONS differ — same name for the same
  // geometry and grade is the intended sharing (see buildPushPayload).
  const byName = new Map()
  for (const r of rows) {
    const k = String(r.propertyName || '').trim()
    const sig = `${r.to.b}x${r.to.h}|${r.to.fc}`
    if (byName.has(k) && byName.get(k) !== sig) {
      errors.push(`"${k}" is used for two different sections — give one of them another name.`)
      break
    }
    byName.set(k, sig)
  }
  return errors
}

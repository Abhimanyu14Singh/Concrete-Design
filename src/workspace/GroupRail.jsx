import { useMemo } from 'react'
import { dcrTone, fmtDcr } from './design'
import { useFmt } from './format'

// The left rail: design groups, with members nested under them.
//
// A group — not a member — is the unit the app actually designs in: one cage checked
// against the envelope of every beam in the set. A flat member list hides that, and at
// import scale (hundreds of beams) it is also unusable. So the rail is a group tree that
// rolls the worst DCR up, and it answers the question you actually arrive with: which
// group is in trouble, and which beam in it is the reason.
//
// Two affordances earn their place at this size and would not at six members: a text
// filter, and a fails-only switch. Both auto-open the groups that still have matches, so
// filtering never leaves you looking at collapsed rows with nothing visible in them.

const TONE = { ok: '#15803d', warn: '#b45309', fail: '#b91c1c', none: '#9ca3af' }

export default function GroupRail({
  groups, designById, totals, memberId, groupId, selectionKind, onPick, onPickGroup,
  openGroups, onToggleGroup, query, onQuery, failsOnly, onFailsOnly,
}) {
  const { section: sectionLabel } = useFmt()
  const q = query.trim().toLowerCase()

  // One pass: resolve each group's members, apply the filters, and roll up. Done here
  // rather than in App because it is presentation — the rail is the only thing that
  // cares which members survived a filter.
  const rows = useMemo(() => groups.map(g => {
    const all = g.memberIds.map(id => designById.get(id)).filter(Boolean)
    const shown = all.filter(d =>
      (!q || d.member.id.toLowerCase().includes(q) || d.member.label.toLowerCase().includes(q)) &&
      (!failsOnly || d.dcr > 1))
    return {
      group: g,
      all,
      shown,
      dcr: all.length ? Math.max(...all.map(d => d.dcr)) : 0,
      fails: all.filter(d => d.dcr > 1).length,
    }
  }), [groups, designById, q, failsOnly])

  const filtering = !!q || failsOnly
  const visible = filtering ? rows.filter(r => r.shown.length) : rows
  const shownCount = rows.reduce((n, r) => n + r.shown.length, 0)

  return (
    <aside className="demo-aside">
      <div className="demo-aside-h"><span>Groups &amp; members</span><span>DCR</span></div>

      <div className="demo-filter">
        <input
          className="demo-filter-input"
          value={query}
          placeholder="Filter by mark or grid…"
          onChange={e => onQuery(e.target.value)}
        />
        <button
          className={'sdash-loads-chip' + (failsOnly ? ' on' : '')}
          title="Show only beams over capacity"
          onClick={() => onFailsOnly(!failsOnly)}
        >
          fails <b>{totals.fails}</b>
        </button>
      </div>

      <div className="demo-list">
        {visible.map(({ group, all, shown, dcr, fails }) => {
          // Open when: you opened it, it is the SELECTED group (otherwise the beam every
          // other panel is describing is hidden inside a collapsed row, and the rail
          // stops telling you where you are), or a filter is on — a search that leaves
          // its matches collapsed appears to have found nothing.
          const open = filtering || !!openGroups[group.id] || group.id === groupId
          const tone = dcrTone(dcr)
          return (
            <div key={group.id} className="demo-grp">
              {/* Selects the GROUP, not a beam in it: the Section panel then shows the
                  group's template cage against the whole set's envelope. Expanding is the
                  same click, so one gesture both opens the group and selects it. */}
              <div className={'demo-grprow' + (group.id === groupId && selectionKind === 'group' ? ' on' : '')}
                   onClick={() => { onToggleGroup(group.id); onPickGroup(group.id) }}>
                <span className={'demo-caret' + (open ? ' open' : '')}>▸</span>
                <span className="demo-grpdot" style={{ background: group.color }} />
                <span className="demo-grpname">
                  <span className="demo-grplabel">{group.label}</span>
                  <span className="demo-grpmeta">
                    {all.length} beam{all.length === 1 ? '' : 's'}
                    {fails ? <span className="demo-grpfail"> · {fails} over</span> : null}
                    {filtering && shown.length !== all.length ? <> · {shown.length} shown</> : null}
                  </span>
                </span>
                <span className="demo-mrow-dcr" style={{ color: TONE[tone] }}>{fmtDcr(dcr)}</span>
              </div>

              {open && shown.map(d => {
                const t = dcrTone(d.dcr)
                return (
                  <div key={d.member.id}
                       className={'demo-mrow' + (d.member.id === memberId && selectionKind === 'member' ? ' on' : '')}
                       onClick={() => onPick(d.member.id, group.id)}>
                    <span className="demo-mrow-bar" style={{ background: TONE[t] }} />
                    <span className="demo-mrow-name">
                      <div className="demo-mrow-id">{d.member.id}</div>
                      <div className="demo-mrow-meta">{sectionLabel(d.member)} · {d.rows.length} rows</div>
                    </span>
                    <span className="demo-mrow-dcr" style={{ color: TONE[t] }}>{fmtDcr(d.dcr)}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
        {!visible.length && <div className="demo-norows">Nothing matches.</div>}
      </div>

      <div className="demo-aside-f">
        <span className="sdash-stat strong"><b>{totals.members}</b> beams in {groups.length} groups</span>
        <span className="sdash-stat"><b>{totals.rows}</b> load rows designed</span>
        <span className={'sdash-stat' + (totals.fails ? ' warn' : '')}>
          <b>{totals.fails}</b> over capacity · <b>{totals.warns}</b> near
        </span>
        {filtering ? <span className="sdash-stat"><b>{shownCount}</b> matching the filter</span> : null}
      </div>
    </aside>
  )
}

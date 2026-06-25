import { useState, useEffect, useRef, useCallback } from 'react';
import type { Project } from '../types';
import { buildReportBytes, type ReportOptions, DEFAULT_REPORT_OPTIONS } from '../utils/export/pdfExport';

interface Props {
  project: Project;
  onClose: () => void;
}

type ScopeKind = 'all' | 'group' | 'selected';

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
};
const PANEL: React.CSSProperties = {
  background: 'white', borderRadius: 14, width: 'min(1100px, 96vw)', height: 'min(86vh, 900px)',
  display: 'flex', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
};
const SIDEBAR: React.CSSProperties = {
  width: 320, flexShrink: 0, borderRight: '1px solid #e5e7eb', display: 'flex',
  flexDirection: 'column', background: '#f9fafb', overflow: 'auto',
};
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1,
  margin: '14px 0 6px',
};
const inp: React.CSSProperties = {
  padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, width: '100%',
  boxSizing: 'border-box',
};

export default function ReportModal({ project, onClose }: Props) {
  const groups = project.designGroups ?? [];

  // Scope controls
  const [scope, setScope] = useState<ScopeKind>('all');
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set(groups.map(g => g.id)));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(project.members.map(m => m.id)));

  // Content toggles
  const [governingOnly, setGoverningOnly] = useState(DEFAULT_REPORT_OPTIONS.governingOnly);
  const [includeDiagrams, setIncludeDiagrams] = useState(DEFAULT_REPORT_OPTIONS.includeDiagrams);
  const [includeCalcs, setIncludeCalcs] = useState(DEFAULT_REPORT_OPTIONS.includeCalcs);
  const [includeCrack, setIncludeCrack] = useState(DEFAULT_REPORT_OPTIONS.includeCrack);
  const [includeOverrides, setIncludeOverrides] = useState(DEFAULT_REPORT_OPTIONS.includeOverrides);

  // Title block
  const [jobNumber, setJobNumber] = useState('');
  const [revision, setRevision] = useState('');

  // Editable project details (pre-filled from project, not mutating project state)
  const [reportName, setReportName] = useState(project.name);
  const [reportEngineer, setReportEngineer] = useState(project.engineer ?? '');
  const [reportDate, setReportDate] = useState(project.date ?? '');

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastBytes = useRef<Uint8Array | null>(null);
  const lastUrl = useRef<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isEC2 = project.code === 'EN1992-1-1';

  const resolveMemberIds = useCallback((): string[] | undefined => {
    if (scope === 'all') return undefined;
    if (scope === 'group') {
      const ids = new Set<string>();
      for (const g of groups) if (groupIds.has(g.id)) g.memberIds.forEach(id => ids.add(id));
      return project.members.filter(m => ids.has(m.id)).map(m => m.id);
    }
    return project.members.filter(m => selectedIds.has(m.id)).map(m => m.id);
  }, [scope, groups, groupIds, selectedIds, project.members]);

  const buildOptions = useCallback((): ReportOptions => ({
    memberIds: resolveMemberIds(),
    governingOnly, includeDiagrams, includeCalcs, includeCrack, includeOverrides,
    jobNumber: jobNumber.trim() || undefined,
    revision: revision.trim() || undefined,
    reportName: reportName.trim() || undefined,
    reportEngineer: reportEngineer.trim() || undefined,
    reportDate: reportDate.trim() || undefined,
  }), [resolveMemberIds, governingOnly, includeDiagrams, includeCalcs, includeCrack, includeOverrides,
      jobNumber, revision, reportName, reportEngineer, reportDate]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = buildOptions();
      if (opts.memberIds && opts.memberIds.length === 0) {
        setError('No members in the current scope — pick at least one.');
        setBusy(false);
        return;
      }
      const bytes = await buildReportBytes(project, opts);
      lastBytes.current = bytes;
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }));
      lastUrl.current = url;
      setPreviewUrl(url);
    } catch (err) {
      setError(`Report generation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [project, buildOptions]);

  // Auto-regenerate preview on any option change, debounced 600 ms so fast toggles don't thrash.
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { void generate(); }, 600);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, groupIds, selectedIds, governingOnly, includeDiagrams, includeCalcs, includeCrack, includeOverrides,
      jobNumber, revision, reportName, reportEngineer, reportDate]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => { if (lastUrl.current) URL.revokeObjectURL(lastUrl.current); };
  }, []);

  function download() {
    const bytes = lastBytes.current;
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    const tag = [reportName.trim() || project.name, jobNumber.trim(), revision.trim()].filter(Boolean).join('_').replace(/\s+/g, '_');
    a.download = `${tag}_Report.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const memberCount = resolveMemberIds()?.length ?? project.members.length;

  return (
    <div style={OVERLAY} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={PANEL}>
        {/* Controls sidebar */}
        <div style={SIDEBAR}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'white' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Report Builder</span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#9ca3af' }}>×</button>
          </div>

          <div style={{ padding: '0 16px 16px' }}>

            {/* Project details */}
            <div style={SECTION_LABEL}>Project Details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <label style={{ fontSize: 10, color: '#9ca3af' }}>Project name</label>
                <input style={inp} value={reportName} onChange={e => setReportName(e.target.value)} placeholder="Project name" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 10, color: '#9ca3af' }}>Engineer</label>
                  <input style={inp} value={reportEngineer} onChange={e => setReportEngineer(e.target.value)} placeholder="Engineer name" />
                </div>
                <div style={{ width: 100 }}>
                  <label style={{ fontSize: 10, color: '#9ca3af' }}>Date</label>
                  <input style={inp} value={reportDate} onChange={e => setReportDate(e.target.value)} placeholder="YYYY-MM-DD" />
                </div>
              </div>
            </div>

            {/* Title block */}
            <div style={SECTION_LABEL}>Title block</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 10, color: '#9ca3af' }}>Job number</label>
                <input style={inp} value={jobNumber} onChange={e => setJobNumber(e.target.value)} placeholder="e.g. 2024-118" />
              </div>
              <div style={{ width: 80 }}>
                <label style={{ fontSize: 10, color: '#9ca3af' }}>Revision</label>
                <input style={inp} value={revision} onChange={e => setRevision(e.target.value)} placeholder="A" />
              </div>
            </div>

            {/* Scope */}
            <div style={SECTION_LABEL}>Scope</div>
            {([['all', 'Whole project'], ['group', 'By design group'], ['selected', 'Selected members']] as const).map(([k, lbl]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151', padding: '3px 0', cursor: 'pointer' }}>
                <input type="radio" name="scope" checked={scope === k} onChange={() => setScope(k)} disabled={k === 'group' && groups.length === 0} />
                {lbl}{k === 'group' && groups.length === 0 ? ' (no groups)' : ''}
              </label>
            ))}

            {scope === 'group' && (
              <div style={{ marginTop: 6, maxHeight: 150, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: 'white' }}>
                {groups.map(g => (
                  <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '2px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={groupIds.has(g.id)} onChange={() => setGroupIds(prev => { const n = new Set(prev); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n; })} />
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: g.color ?? '#9ca3af', flexShrink: 0 }} />
                    {g.label} <span style={{ color: '#9ca3af' }}>({g.memberIds.length})</span>
                  </label>
                ))}
              </div>
            )}

            {scope === 'selected' && (
              <div style={{ marginTop: 6, maxHeight: 180, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: 'white' }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <button onClick={() => setSelectedIds(new Set(project.members.map(m => m.id)))} style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer' }}>All</button>
                  <button onClick={() => setSelectedIds(new Set())} style={{ fontSize: 10, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>None</button>
                </div>
                {project.members.map(m => (
                  <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '2px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selectedIds.has(m.id)} onChange={() => setSelectedIds(prev => { const n = new Set(prev); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; })} />
                    {m.label}
                  </label>
                ))}
              </div>
            )}

            {/* Content */}
            <div style={SECTION_LABEL}>Content</div>
            {[
              ['Governing load case only', governingOnly, setGoverningOnly],
              ['Shear & moment diagrams', includeDiagrams, setIncludeDiagrams],
              ['Step-by-step calcs + clauses', includeCalcs, setIncludeCalcs],
              ['Engineer review stamps', includeOverrides, setIncludeOverrides],
            ].map(([lbl, val, set]) => (
              <label key={lbl as string} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151', padding: '3px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={val as boolean} onChange={e => (set as (v: boolean) => void)(e.target.checked)} />
                {lbl as string}
              </label>
            ))}
            {isEC2 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151', padding: '3px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeCrack} onChange={e => setIncludeCrack(e.target.checked)} />
                EC2 crack-width check
              </label>
            )}

            <button
              onClick={() => { void generate(); }}
              disabled={busy}
              style={{ marginTop: 16, width: '100%', padding: '10px', background: busy ? '#93c5fd' : '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: busy ? 'default' : 'pointer' }}
            >
              {busy ? 'Generating…' : '↻ Refresh Preview'}
            </button>
            <button
              onClick={download}
              disabled={busy || !lastBytes.current}
              style={{ marginTop: 8, width: '100%', padding: '10px', background: 'white', color: '#16a34a', border: '1px solid #86efac', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: busy || !lastBytes.current ? 'default' : 'pointer' }}
            >
              ↓ Download PDF
            </button>
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 8, textAlign: 'center' }}>
              {memberCount} member{memberCount !== 1 ? 's' : ''} in report
              {busy && ' · updating…'}
            </div>
            {error && (
              <div style={{ marginTop: 10, fontSize: 11, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 10px' }}>
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Preview pane */}
        <div style={{ flex: 1, minWidth: 0, background: '#525659', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
          {previewUrl ? (
            <iframe title="Report preview" src={previewUrl} style={{ width: '100%', height: '100%', border: 'none', opacity: busy ? 0.5 : 1, transition: 'opacity 0.2s' }} />
          ) : (
            <div style={{ color: '#cbd5e1', fontSize: 13 }}>{busy ? 'Rendering report…' : 'Preview will appear here.'}</div>
          )}
          {busy && previewUrl && (
            <div style={{ position: 'absolute', top: 12, right: 16, background: 'rgba(0,0,0,0.6)', color: 'white', borderRadius: 6, padding: '4px 10px', fontSize: 11 }}>
              Updating…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { Project } from '../types';
import { exportExcel } from '../utils/export/excelExport';
import { exportPDF } from '../utils/export/pdfExport';

interface Props {
  project: Project;
  onClose: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
};
const MODAL: React.CSSProperties = {
  background: '#0a1628', border: '1px solid #1e293b', borderRadius: 14,
  padding: '28px 28px 24px', width: 380, boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
};

export default function ExportModal({ project, onClose }: Props) {
  const [busy, setBusy] = useState<'pdf' | 'excel' | null>(null);

  async function handlePDF() {
    setBusy('pdf');
    try {
      await exportPDF(project);
      onClose();
    } catch (err) {
      alert(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  function handleExcel() {
    setBusy('excel');
    try {
      exportExcel(project);
      onClose();
    } catch (err) {
      alert(`Excel export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={OVERLAY} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={MODAL}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>Export Results</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        <div style={{ fontSize: 11, color: '#475569', marginBottom: 16 }}>
          Export all members × all load cases for <strong style={{ color: '#94a3b8' }}>{project.name}</strong>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            onClick={handlePDF}
            disabled={busy !== null}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: busy === 'pdf' ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10,
              padding: '14px 16px', cursor: busy ? 'default' : 'pointer', width: '100%', textAlign: 'left',
            }}>
            <span style={{ fontSize: 22 }}>📄</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fca5a5' }}>
                {busy === 'pdf' ? 'Generating PDF…' : 'PDF Report'}
              </div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                Cover page, member summaries, DCR tables, warnings with ACI references
              </div>
            </div>
          </button>

          <button
            onClick={handleExcel}
            disabled={busy !== null}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: busy === 'excel' ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.08)',
              border: '1px solid rgba(16,185,129,0.3)', borderRadius: 10,
              padding: '14px 16px', cursor: busy ? 'default' : 'pointer', width: '100%', textAlign: 'left',
            }}>
            <span style={{ fontSize: 22 }}>📊</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#6ee7b7' }}>
                {busy === 'excel' ? 'Generating Excel…' : 'Excel Spreadsheet'}
              </div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                Summary sheet + per-member sheets with all load case results
              </div>
            </div>
          </button>
        </div>

        <div style={{ fontSize: 9, color: '#334155', marginTop: 16, textAlign: 'center' }}>
          All calculations per ACI 318-19
        </div>
      </div>
    </div>
  );
}

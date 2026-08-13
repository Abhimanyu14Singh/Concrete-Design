import MemberEditor from '../../../src/components/SectionInput/MemberEditor.tsx'
import PanelFrame from '../PanelFrame.js'

// The input side of today's Member tab, as a panel: the app's real MemberEditor.
//
// It is the panel that makes the architecture pay off. Detach it onto a second monitor
// and you can change b, h, cover or the cage on one screen while the section drawing,
// the DCR chips and the calc sheet update on the other — none of which is possible when
// the editor is one half of a fixed split.
//
// It also exercises the harder direction of the bus. `onUpdate` hands back a WHOLE
// Member, so the edit travels as data and is applied by the main window's reducer. The
// panel never mutates anything itself, which is why the same component works in both
// hosts without a branch.
export default function EditorPanel({ member, code, onUpdate, ...frame }) {
  return (
    <PanelFrame {...frame} title="Editor" subtitle={member.id}>
      <div className="demo-scroll demo-pad demo-editor">
        {/* keyed on the member so switching beams remounts the editor's local draft
            instead of showing the previous beam's half-typed values */}
        <MemberEditor key={member.id} member={member} code={code} onUpdate={onUpdate} />
      </div>
    </PanelFrame>
  )
}

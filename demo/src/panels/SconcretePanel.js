import SconcreteDashboard from '../../../src/components/Dashboard/SconcreteDashboard.tsx'
import PanelFrame from '../PanelFrame.js'

// S-Concrete Verify — the app's own batch designer, in a panel.
//
// This is the last step of the workflow the app exists to serve: ETABS import → design →
// group → **verify against S-Concrete**. It writes one `.SCO` per group, drives
// S-Concrete's BatchReporter through the bundled SConcreteHelper sidecar, reads the
// `.SCRS` back, and shows each group's status beside the app's own governing DCR.
//
// Nothing here reimplements any of that: `SconcreteDashboard`, `useSconcreteBatch`,
// `scoWriter`, `scrsParser` and `resultStatus` are the product's. The panel supplies the
// three things the dashboard wants from a host — a project, a dashboard payload, and a
// memberId → frameName map — and hands results back up.
//
// WHERE IT RUNS. Writing the files and driving BatchReporter are native operations, so
// they need the desktop shell (`npm run desktop`) with S-Concrete installed. In the
// browser the dashboard says so itself and everything else still works; that is the
// app's own behaviour on web, not a demo limitation, so it is left to speak for itself.
//
// THE PROJECT PROP is synthesised in App.js rather than kept as state: this workspace
// has members and groups, not a Project. It is plain data all the way down, which it has
// to be — a detached panel receives it through structuredClone.
export default function SconcretePanel({
  project, payload, frameOf, selectedGroupId,
  onSelectGroup, onOpenMember, onProjectPatch,
  ...frame
}) {
  const groups = payload?.groups ?? []
  const ran = project?.sconcreteRanAt

  return (
    <PanelFrame
      {...frame}
      title="S-Concrete"
      subtitle={ran ? `${groups.length} groups · ran ${new Date(ran).toLocaleTimeString()}` : `${groups.length} groups · not run`}
    >
      {() => (
        <div className="demo-sco">
          <SconcreteDashboard
            project={project}
            payload={payload}
            // A Map cannot be assumed across the bus, so the pairs travel and the Map is
            // rebuilt here. Cheap, and it keeps the payload plainly cloneable.
            frameByMemberId={new Map(frameOf ?? [])}
            selectedGroupId={selectedGroupId}
            onSelectGroup={onSelectGroup}
            onOpenMember={onOpenMember}
            // The hook hands back an UPDATER, and a function cannot cross to a detached
            // window. So it is applied HERE, against the project prop this panel already
            // holds, and only the plain result travels. The main window stays the owner
            // of the state — it just receives the new value instead of the recipe.
            onProjectChange={onProjectPatch ? updater => {
              const next = updater(project)
              onProjectPatch({
                sconcreteResults: next.sconcreteResults ?? null,
                sconcreteRanAt: next.sconcreteRanAt ?? null,
                slsCombo: next.slsCombo ?? null,
              })
            } : undefined}
          />
        </div>
      )}
    </PanelFrame>
  )
}

import ElevationView from '../../../src/components/Detailing/ElevationView.tsx'
import PanelFrame from '../PanelFrame.js'

// The beam in elevation — the app's own ElevationView.
//
// This is the view that most wants its own window: it is long and short, so tiled beside
// three other panels it gets a third of the width it deserves, and detached onto a wide
// monitor it finally reads. Same component either way; only the box it is given changes.
//
// `regions` is what makes it a detailing drawing rather than a diagram: link spacing AND
// both faces of steel, stated per L/3 rather than as one value for the whole beam.
export default function ElevationPanel({ member, regions, ...frame }) {
  return (
    <PanelFrame {...frame} title="Elevation" subtitle={member.id}>
      {box => (
        <div className="demo-draw top" style={{ overflow: 'auto' }}>
          <ElevationView
            member={member}
            regions={regions}
            width={Math.max(320, box.w - 16)}
            /* Taller floor than the plain elevation: the per-third callouts claim a band
               above and below the beam, and squeezing them collides the two. */
            height={Math.max(220, Math.min(box.h - 16, 380))}
          />
        </div>
      )}
    </PanelFrame>
  )
}

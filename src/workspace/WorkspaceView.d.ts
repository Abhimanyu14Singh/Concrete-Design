/**
 * Type surface for the panel workspace.
 *
 * The workspace itself is `.jsx` — it came across from the demo, where it was written in
 * plain JS, and rewriting ~1500 lines into TypeScript in the same change that repointed
 * the shell would have made a risky migration unreviewable. `allowJs` is off, so tsc sees
 * nothing of that file; this declaration is the contract App is held to instead, and it
 * is deliberately narrow: the project, and the four things only App can do.
 */
import type { Project, ProjectSettings, DesignCode } from '../types';

export interface WorkspaceViewProps {
  /** The model. The workspace reads it and writes it; it holds no copy of its own. */
  project: Project;
  setProject: (p: Project | ((prev: Project) => Project)) => void;
  /** Applied by App through applyProjectSettings, so the imported-materials rule runs once. */
  onSettingsSave?: (next: { name: string; code: DesignCode; settings: ProjectSettings }) => void;
  /** Disk and ETABS — App's, because they outlive any panel. */
  onSaveProject?: () => void;
  onOpenProject?: () => void;
  onNewProject?: () => void;
  onImportEtabs?: () => void;
}

declare const WorkspaceView: (props: WorkspaceViewProps) => JSX.Element;
export default WorkspaceView;

/**
 * Hidden features — built into the app, off in the shipped UI.
 *
 * This is for things that are finished and working but that a normal import should not
 * have to walk past. Deleting them would mean rewriting them the day they are wanted;
 * commenting them out would rot silently, because nothing type-checks or bundles a
 * comment. A flag keeps the code on the compiler's and the test suite's radar while
 * keeping it off the screen.
 *
 * EACH FLAG HAS A RUNTIME ESCAPE HATCH. A compile-time constant alone would mean that
 * wanting the feature back in an INSTALLED build costs a whole release — which is
 * exactly the moment it is usually wanted, because the model that is misbehaving is on
 * a client machine and not in a dev tree. So the default is off, and one line in the
 * DevTools console turns it on for that machine:
 *
 *     localStorage.setItem('sdash.flag.importDiagnostics', '1')   // then reload
 *     localStorage.removeItem('sdash.flag.importDiagnostics')     // off again
 *
 * Read them through `flagOn()` rather than touching localStorage directly, so the key
 * spelling lives in one place and a private-mode throw cannot break a render.
 */

const PREFIX = 'sdash.flag.';

/** Flags that exist. Keeping them in one union is what stops a typo'd key from reading
 *  as a permanently-off feature nobody can explain. */
export type Flag =
  /** The ETABS import wizard's "Diagnostics" panel on step 2 (Filter) — why a layer came
   *  back empty, what tables the model exposes. Answers a question most imports never
   *  raise, on a step that is already dense. */
  | 'importDiagnostics';

/**
 * Is this hidden feature switched on for this machine?
 *
 * False everywhere by default, including dev: a flag that is quietly on in the dev tree
 * and off in the installer is how a feature gets shipped broken, because the only build
 * anyone tested is the one where it was visible.
 */
export function flagOn(flag: Flag): boolean {
  try {
    return localStorage.getItem(PREFIX + flag) === '1';
  } catch {
    // Private mode, disabled storage, a non-DOM test runner — a hidden feature staying
    // hidden is the safe answer, and it is never worth an exception during render.
    return false;
  }
}

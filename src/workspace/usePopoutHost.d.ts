/**
 * Type surface for the popout host — only the pure decision helper, which is the part
 * typed code (its test) touches. The hook itself is consumed by `.jsx` inside the
 * workspace and is deliberately not declared; see `popoutBus.d.ts` for the same rule.
 */

/** Whether a panel's payload needs posting — props changed, OR it moved window. */
export declare function needsPost(
  prevProps: unknown, prevWin: string | null | undefined,
  props: unknown, win: string | null,
): boolean;

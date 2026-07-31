/**
 * Group-name templates for the auto-grouper.
 *
 * A template is any literal string with {tokens} the user can mix with their own
 * text and punctuation. Tokens (case-insensitive):
 *
 *   {type}    B for a beam, C for a column
 *   {depth}   section depth in mm ÷ 100, 2-digit   (700 mm → "07", 1200 mm → "12")
 *   {width}   section width in mm ÷ 100, 2-digit   (300 mm → "03")
 *   {depthmm} full section depth in mm             (700 mm → "700")
 *   {seq}     running index of groups sharing the same depth, 2-digit (01, 02, …)
 *   {n}       global group number, 2-digit
 *   {face}    T (top / M⁻ governed) or B (bottom / M⁺ governed); '' when not split
 *   {story}   the group's story label
 *
 * Example: "{type}-{depth}-{seq}"  →  "B-07-01", "B-12-04".
 *
 * When the user splits by face, the T/B is NOT baked into the name — it is carried
 * on the group as `face` and shown as a (T)/(B) badge on the group dashboard, while
 * the legend keeps the clean template name. Put {face} in the template only if you
 * DO want it inside the name itself.
 */

export interface GroupNameContext {
  isColumn: boolean;
  depthMm: number;   // section depth (mm)
  widthMm: number;   // section width (mm)
  seq: number;       // 1-based sequence among groups of the same depth
  n: number;         // 1-based global group index
  face?: 'top' | 'bot';
  story?: string;
}

const pad2 = (n: number) => String(Math.max(0, Math.round(n))).padStart(2, '0');

/** Depth code = mm ÷ 100, 2-digit. 700 mm → "07", 1200 mm → "12". */
export function depthCodeMm(depthMm: number): string {
  return pad2(depthMm / 100);
}

/** Expand a group-name template against one group's context. Unknown tokens are
 *  left as-is so a typo is visible rather than silently dropped. */
export function formatGroupName(template: string, ctx: GroupNameContext): string {
  const tokens: Record<string, string> = {
    type: ctx.isColumn ? 'C' : 'B',
    depth: depthCodeMm(ctx.depthMm),
    width: depthCodeMm(ctx.widthMm),
    depthmm: String(Math.round(ctx.depthMm)),
    seq: pad2(ctx.seq),
    n: pad2(ctx.n),
    face: ctx.face === 'top' ? 'T' : ctx.face === 'bot' ? 'B' : '',
    story: ctx.story ?? '',
  };
  return template
    .replace(/\{(\w+)\}/g, (m, key: string) => {
      const k = key.toLowerCase();
      return k in tokens ? tokens[k] : m;
    })
    .trim();
}

/** Tokens shown as a hint under the template input. */
export const GROUP_NAME_TOKENS: { token: string; desc: string }[] = [
  { token: '{type}', desc: 'B/C' },
  { token: '{depth}', desc: 'depth mm÷100' },
  { token: '{width}', desc: 'width mm÷100' },
  { token: '{seq}', desc: 'per-depth 01…' },
  { token: '{n}', desc: 'group #' },
  { token: '{face}', desc: 'T/B' },
];

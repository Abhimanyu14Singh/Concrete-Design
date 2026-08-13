// UI copy helpers. The app speaks in fragments, not sentences: a label names a
// thing, a message states what happened plus the numbers that matter. These three
// functions are the whole mechanism — see msg.py for the Python side.
//
// STYLE (applies to every user-facing string in the island)
//   Labels / buttons / tooltips / view names   Title Case, 1-4 words, no period
//   Empty states                               <= 6 words, no period
//   Messages                                   fact only, counts first, no advice
//   Separator                                  " · " between co-equal fragments
//   Terminology                                story · Color · Utilization ·
//                                              analyzed · AutoSize / AutoDetail /
//                                              AutoStack · f'c (straight quote)
// Units and symbols keep their own casing: in mm ksi MPa kip kN ρ φ δ f'c DCR.
// Explanation belongs in the Help window and the console, never in the chrome.

// 996 -> "996"; 1204 -> "1,204". One place, so counts never disagree.
export const n = (v) => Number(v || 0).toLocaleString();

// plural(1, "frame") -> "1 frame"; plural(996, "frame") -> "996 frames".
// Pass `many` for irregulars: plural(2, "story", "stories").
export const plural = (v, one, many) =>
  `${n(v)} ${Number(v) === 1 ? one : (many || one + "s")}`;

// join("Pushed 996 frames", "", "68 sections") -> "Pushed 996 frames · 68 sections".
// Falsy fragments drop out, so callers can pass a conditional straight through.
export const join = (...parts) => parts.filter(Boolean).join(" · ");

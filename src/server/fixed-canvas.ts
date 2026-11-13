// This compatibility rule preserves the declared width of the common
// viewport > stage > slide layout. The deck still owns its size and fit script.
// Zero specificity lets an author's explicit flex rules take precedence.
const FIXED_CANVAS_STYLE = Buffer.from(
  '<style data-html-studio-canvas>:where(#viewport > #stage:has(> .slide)){flex-shrink:0}</style>',
  "utf8"
);
const LAYOUT_MARKERS = ["#viewport", "#stage", ".slide"].map(marker => Buffer.from(marker, "utf8"));

export function getFixedCanvasStyle(source: Buffer): Buffer | null {
  // A cheap bounded-buffer prefilter avoids changing ordinary documents.
  // The actual DOM relationship is checked by the CSS selector, so markers in
  // comments or strings cannot make this rule affect an unrelated element.
  return LAYOUT_MARKERS.every(marker => source.includes(marker)) ? FIXED_CANVAS_STYLE : null;
}

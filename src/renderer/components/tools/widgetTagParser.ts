/**
 * Widget Tag Parser — Extracts <generative-ui-widget> tags from streaming text.
 *
 * Splits text content into segments: plain text and widget blocks.
 * Used by Message.tsx to render widgets inline with Markdown content.
 *
 * Handles:
 * - Complete widgets: <generative-ui-widget title="xxx">HTML</generative-ui-widget>
 * - Partial/streaming widgets: <generative-ui-widget title="xxx">partial HTML...
 * - Multiple widgets in a single text block
 * - Text before, between, and after widgets
 * - Tags inside code fences are ignored (not treated as real widgets)
 * - Single or double quotes for title attribute
 * - Extra attributes on the tag (ignored, only title extracted)
 */

export interface WidgetSegment {
  type: 'widget';
  title: string;
  code: string;
  isComplete: boolean;
}

export interface TextSegment {
  type: 'text';
  content: string;
}

export type Segment = TextSegment | WidgetSegment;

// Tag name used for widget output — unique enough to avoid accidental collisions
const TAG_NAME = 'generative-ui-widget';

// Match opening tag: <generative-ui-widget> or <generative-ui-widget title="xxx">
// Title is optional — captured if present (group 1), empty string if absent.
//
// Lookbehind `(?<=^|\n)` requires the tag to appear at line start (after
// optional indent). The widget output contract (see generative-ui-tool.ts
// SECTION_OUTPUT_FORMAT) puts the opening tag on its own line, so this is safe.
// Without it, mid-line mentions of the tag in prose ("outputting any
// <generative-ui-widget> tags") get matched and swallow the rest of the message
// as an "unclosed widget".
const WIDGET_OPEN_RE = new RegExp(
  `(?<=^|\\n)[ \\t]*<${TAG_NAME}(?:\\s+[^>]*?title\\s*=\\s*["']([^"']+)["'][^>]*|\\s*)>`, 'i'
);
// Used to bound the close-tag search inside an already-opened widget. Requires
// an actual `\n` before the tag (not just substring start, which `^` would
// match), so the very first char after the parent's opening tag isn't
// mistaken for "next widget".
const NEXT_WIDGET_OPEN_RE = new RegExp(
  `\\n[ \\t]*<${TAG_NAME}(?:\\s+[^>]*?title\\s*=\\s*["']([^"']+)["'][^>]*|\\s*)>`, 'i'
);
// Match closing tag
const WIDGET_CLOSE_STR = `</${TAG_NAME}>`;

/**
 * Mask code regions (fenced blocks AND inline code spans) before scanning for
 * widget tags. Without inline-code masking, a literal mention like
 * `` `<generative-ui-widget>` `` matches the open regex and the parser then
 * treats everything up to a (non-existent) closing tag as widget HTML.
 * Same-length NUL placeholder preserves character indices for downstream slicing.
 */
function maskCodeRegions(text: string): { masked: string } {
  let masked = text;
  // Fenced first — protects ` characters inside ``` blocks from inline pass.
  masked = masked.replace(/```[\s\S]*?```/g, (match) => '\x00'.repeat(match.length));
  // Inline code spans — N backticks open, same N close. Single-line only
  // (multi-line inline code is legal per CommonMark but vanishingly rare for
  // tag mentions). Backreference `\1` ensures the closer length matches.
  masked = masked.replace(/(`+)[^\n]*?\1/g, (match) => '\x00'.repeat(match.length));
  return { masked };
}

/**
 * Parse text into segments of plain text and widget blocks.
 * Supports streaming: if text ends mid-widget (no closing tag), returns
 * the widget with isComplete=false.
 * Tags inside code fences (```) are ignored.
 */
export function parseWidgetTags(text: string): Segment[] {
  const segments: Segment[] = [];
  let remaining = text;
  let maskedRemaining = maskCodeRegions(text).masked;

  while (remaining.length > 0) {
    // Search in masked text (code regions replaced) to avoid false positives
    const openMatch = WIDGET_OPEN_RE.exec(maskedRemaining);

    if (!openMatch) {
      if (remaining.trim()) {
        segments.push({ type: 'text', content: remaining });
      }
      break;
    }

    // Text before the widget tag
    const textBefore = remaining.slice(0, openMatch.index);
    if (textBefore.trim()) {
      segments.push({ type: 'text', content: textBefore });
    }

    const title = openMatch[1] || '';
    const afterOpenIdx = openMatch.index + openMatch[0].length;
    const afterOpen = remaining.slice(afterOpenIdx);
    const afterOpenMasked = maskedRemaining.slice(afterOpenIdx);

    // Bound the close-tag search by the next widget's opening tag (if any).
    // `lastIndexOf` within the bounded range preserves the original safety
    // (a literal close-tag string inside widget JS doesn't trigger premature
    // close) while still supporting multiple widgets in one message — which
    // the contract explicitly allows (see SECTION_OUTPUT_FORMAT rules).
    const nextOpenMatch = NEXT_WIDGET_OPEN_RE.exec(afterOpenMasked);
    const searchEnd = nextOpenMatch ? nextOpenMatch.index : afterOpen.length;

    const closeStr = WIDGET_CLOSE_STR.toLowerCase();
    const closeIdx = afterOpen.slice(0, searchEnd).toLowerCase().lastIndexOf(closeStr);

    if (closeIdx !== -1) {
      const widgetCode = afterOpen.slice(0, closeIdx);
      segments.push({
        type: 'widget',
        title,
        code: widgetCode,
        isComplete: true,
      });
      const afterClose = afterOpenIdx + closeIdx + WIDGET_CLOSE_STR.length;
      remaining = remaining.slice(afterClose);
      // Slice the running masked window, NOT the original masked text — the
      // two would only agree when starting at offset 0, so reusing the
      // original drifts the mask window after the first close.
      maskedRemaining = maskedRemaining.slice(afterClose);
    } else {
      // Partial widget (still streaming)
      segments.push({
        type: 'widget',
        title,
        code: afterOpen,
        isComplete: false,
      });
      break;
    }
  }

  return segments;
}

/**
 * Quick check: does the text contain any widget tags (outside code fences)?
 */
export function hasWidgetTags(text: string): boolean {
  const { masked } = maskCodeRegions(text);
  return WIDGET_OPEN_RE.test(masked);
}

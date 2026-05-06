import { describe, expect, test } from 'vitest';

import { hasWidgetTags, parseWidgetTags } from './widgetTagParser';

describe('widget tag false-positive guards', () => {
  // Repro of image 2 bug: literal `<generative-ui-widget>` in inline code
  // used to be matched as a real opening tag, swallowing the rest of the
  // message as an unclosed widget.
  test('inline code mentioning the tag is not parsed as a widget', () => {
    const input =
      '5. **零 wire 协议变更** —— `<generative-ui-widget>` 标签格式不变\n\n## 需要权衡的风险';

    expect(hasWidgetTags(input)).toBe(false);
    expect(parseWidgetTags(input)).toEqual([{ type: 'text', content: input }]);
  });

  // Repro of image 1 bug: mid-line mention inside a blockquote also
  // swallowed everything after.
  test('mid-line mention inside a blockquote is not parsed as a widget', () => {
    const input = [
      '> Load the design guidelines for creating interactive visual widgets.',
      '> You MUST call this before outputting any <generative-ui-widget> tags.',
      '> ...',
      '',
      '只描述了 "是什么 + 怎么调"',
    ].join('\n');

    expect(hasWidgetTags(input)).toBe(false);
    expect(parseWidgetTags(input)).toEqual([{ type: 'text', content: input }]);
  });

  test('tag inside a fenced code block is not parsed as a widget', () => {
    const input = [
      'Example:',
      '```',
      '<generative-ui-widget>',
      'something',
      '</generative-ui-widget>',
      '```',
      'after',
    ].join('\n');

    expect(hasWidgetTags(input)).toBe(false);
  });

  test('real widget at line start is still parsed', () => {
    const input = [
      'Intro text.',
      '',
      '<generative-ui-widget title="demo">',
      '<div>hi</div>',
      '</generative-ui-widget>',
      '',
      'Outro text.',
    ].join('\n');

    expect(hasWidgetTags(input)).toBe(true);
    const segs = parseWidgetTags(input);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: 'text', content: 'Intro text.\n\n' });
    expect(segs[1]).toMatchObject({
      type: 'widget',
      title: 'demo',
      isComplete: true,
    });
    expect(segs[2]).toEqual({ type: 'text', content: '\n\nOutro text.' });
  });

  test('real widget with leading indent is still parsed', () => {
    const input = '  <generative-ui-widget>\nhtml\n</generative-ui-widget>';
    expect(hasWidgetTags(input)).toBe(true);
    const segs = parseWidgetTags(input);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: 'widget', isComplete: true });
  });

  test('partial (streaming) widget at line start still flagged incomplete', () => {
    const input = 'Intro\n\n<generative-ui-widget>\n<div>partial';
    const segs = parseWidgetTags(input);
    expect(segs).toHaveLength(2);
    expect(segs[1]).toMatchObject({ type: 'widget', isComplete: false });
  });

  // Regression guard: when ≥2 widgets close in one message, the masked-region
  // window must stay aligned with the remaining-text window. A pre-existing
  // off-by-base slice (`maskedRemaining = masked.slice(...)` instead of
  // `maskedRemaining.slice(...)`) drifts the mask after iteration 2 and lets
  // a later inline-code mention escape masking and get parsed as a widget.
  test('two real widgets followed by an inline-code mention all parse correctly', () => {
    const input = [
      '<generative-ui-widget title="a">',
      'A',
      '</generative-ui-widget>',
      '',
      'mid',
      '',
      '<generative-ui-widget title="b">',
      'B',
      '</generative-ui-widget>',
      '',
      'After `<generative-ui-widget>` mention.',
    ].join('\n');

    const segs = parseWidgetTags(input);
    expect(segs.map((s) => s.type)).toEqual(['widget', 'text', 'widget', 'text']);
    expect(segs[0]).toMatchObject({ type: 'widget', title: 'a', isComplete: true });
    expect(segs[2]).toMatchObject({ type: 'widget', title: 'b', isComplete: true });
    expect((segs[3] as { type: 'text'; content: string }).content).toContain(
      'After `<generative-ui-widget>` mention.'
    );
  });

  test('double-backtick inline span mentioning the tag is not parsed as a widget', () => {
    const input = 'See ``<generative-ui-widget>`` for the literal tag.';
    expect(hasWidgetTags(input)).toBe(false);
    expect(parseWidgetTags(input)).toEqual([{ type: 'text', content: input }]);
  });
});

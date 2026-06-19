import { describe, expect, it } from 'vitest';

import {
  buildFilePatchDisplayDescriptor,
  resolveFilePatchDisplay,
} from './filePatch';

describe('filePatch display protocol', () => {
  it('builds a compact descriptor for builtin Edit without duplicating old/new text', () => {
    const descriptor = buildFilePatchDisplayDescriptor({
      name: 'Edit',
      input: {
        file_path: '/tmp/example.md',
        old_string: 'old body\nsecond line',
        new_string: 'new body',
        replace_all: true,
      },
    });

    expect(descriptor).toMatchObject({
      kind: 'file_patch',
      version: 1,
      source: 'builtin',
      replaceAll: true,
      summary: { files: 1, added: 1, removed: 2 },
      changes: [{ kind: 'update', path: '/tmp/example.md', view: { kind: 'old-new' } }],
    });
    expect(JSON.stringify(descriptor)).not.toContain('old body');
    expect(JSON.stringify(descriptor)).not.toContain('new body');
  });

  it('builds a compact descriptor for Codex fileChange without duplicating diffs', () => {
    const descriptor = buildFilePatchDisplayDescriptor({
      name: 'Edit',
      input: {
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra',
          },
        ],
      },
      resultMeta: { status: 'completed' },
    });

    expect(descriptor).toMatchObject({
      kind: 'file_patch',
      version: 1,
      source: 'codex',
      summary: { files: 1, added: 2, removed: 1 },
      changes: [{ kind: 'update', path: '/tmp/a.md', view: { kind: 'unified-diff' } }],
    });
    expect(JSON.stringify(descriptor)).not.toContain('-old');
    expect(JSON.stringify(descriptor)).not.toContain('+extra');
  });

  it('resolves new descriptors by materializing text from legacy inputJson', () => {
    const display = resolveFilePatchDisplay({
      name: 'Write',
      inputJson: JSON.stringify({
        file_path: '/tmp/generated.md',
        content: 'one\ntwo\n',
      }),
      display: {
        kind: 'file_patch',
        version: 1,
        source: 'builtin',
        summary: { files: 1, added: 2, removed: 0 },
        changes: [
          {
            kind: 'add',
            path: '/tmp/generated.md',
            added: 2,
            removed: 0,
            view: { kind: 'content' },
          },
        ],
      },
    });

    expect(display?.summary).toEqual({ files: 1, added: 2, removed: 0 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'content', content: 'one\ntwo\n' });
  });

  it('falls through partial parsedInput to complete inputJson for Write', () => {
    const display = resolveFilePatchDisplay({
      name: 'Write',
      parsedInput: { file_path: '/tmp/generated.md' },
      inputJson: JSON.stringify({
        file_path: '/tmp/generated.md',
        content: 'complete body',
      }),
    });

    expect(display?.summary).toEqual({ files: 1, added: 1, removed: 0 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'content', content: 'complete body' });
  });

  it('falls through partial parsedInput to complete inputJson for Codex fileChange', () => {
    const display = resolveFilePatchDisplay({
      name: 'Edit',
      parsedInput: {
        file_path: '/tmp/a.md',
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
          },
        ],
      },
      inputJson: JSON.stringify({
        file_path: '/tmp/a.md',
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      }),
    });

    expect(display?.summary).toEqual({ files: 1, added: 1, removed: 1 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'unified-diff', diff: '@@ -1 +1 @@\n-old\n+new' });
  });

  it('keeps old history compatible when only raw input is available', () => {
    const display = resolveFilePatchDisplay({
      name: 'Edit',
      input: {
        file_path: '/tmp/raw.md',
        old_string: '',
        new_string: 'created',
      },
    });

    expect(display?.summary).toEqual({ files: 1, added: 1, removed: 0 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'old-new', oldText: '', newText: 'created' });
  });

  it('waits for both builtin Edit sides before producing a display summary', () => {
    expect(resolveFilePatchDisplay({
      name: 'Edit',
      parsedInput: {
        file_path: '/tmp/streaming.md',
        old_string: 'old only',
      },
    })).toBeNull();
  });

  it('keeps diff-less Codex moves materialized for header/status rendering', () => {
    const display = resolveFilePatchDisplay({
      name: 'Edit',
      input: {
        changes: [
          {
            path: '/tmp/old.md',
            kind: { type: 'move', move_path: '/tmp/new.md' },
          },
        ],
      },
      result: '[declined]\nmove: /tmp/old.md -> /tmp/new.md',
      resultMeta: { status: 'declined' },
    });

    expect(display).toMatchObject({
      status: 'declined',
      summary: { files: 1, added: 0, removed: 0 },
      changes: [
        {
          kind: 'move',
          path: '/tmp/old.md',
          movePath: '/tmp/new.md',
          view: { kind: 'unified-diff', diff: '' },
        },
      ],
    });
  });
});

import { describe, expect, it } from 'vitest';

import type { Project } from '../types';
import {
  getSystemPresetProjectMetadataPatch,
  isProjectVisibleToUser,
  isSystemPresetProject,
} from '../types';
import { applyProjectRemovalIntent } from './projectService';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'workspace',
    path: '/tmp/workspace',
    providerId: null,
    permissionMode: null,
    ...overrides,
  };
}

describe('system preset workspace helpers', () => {
  it('identifies system preset projects by lifecycle metadata, not template source alone', () => {
    expect(isSystemPresetProject(project({
      workspaceType: 'system-preset',
      systemPresetId: 'mino',
    }))).toBe(true);

    expect(isSystemPresetProject(project({
      templateId: 'mino',
      templateSource: 'builtin',
    }))).toBe(false);
  });

  it('excludes internal and hidden projects from user-facing workspace lists', () => {
    expect(isProjectVisibleToUser(project())).toBe(true);
    expect(isProjectVisibleToUser(project({ internal: true }))).toBe(false);
    expect(isProjectVisibleToUser(project({ hidden: true }))).toBe(false);
  });

  it('repairs only missing system preset metadata without overwriting user-facing customizations', () => {
    const patch = getSystemPresetProjectMetadataPatch(project({
      displayName: 'My Mino',
      icon: 'star',
      path: '/Users/me/.myagents/projects/mino',
    }), 'mino');

    expect(patch).toMatchObject({
      workspaceType: 'system-preset',
      systemPresetId: 'mino',
      templateId: 'mino',
      templateSource: 'builtin',
    });
    expect(patch.displayName).toBeUndefined();
    expect(patch.icon).toBeUndefined();
    expect(patch.hidden).toBeUndefined();
  });
});

describe('applyProjectRemovalIntent', () => {
  it('removes ordinary workspaces from the project registry', () => {
    const ordinary = project({ id: 'ordinary' });
    const other = project({ id: 'other', path: '/tmp/other' });

    const result = applyProjectRemovalIntent([ordinary, other], ordinary.id, '2026-06-11T00:00:00.000Z');

    expect(result?.action).toBe('removed');
    expect(result?.project).toEqual(ordinary);
    expect(result?.projects).toEqual([other]);
  });

  it('soft-deletes system preset workspaces', () => {
    const mino = project({
      id: 'mino-project',
      path: '/Users/me/.myagents/projects/mino',
      workspaceType: 'system-preset',
      systemPresetId: 'mino',
    });
    const other = project({ id: 'other', path: '/tmp/other' });

    const result = applyProjectRemovalIntent([mino, other], mino.id, '2026-06-11T00:00:00.000Z');

    expect(result?.action).toBe('hidden');
    expect(result?.projects).toHaveLength(2);
    expect(result?.project).toMatchObject({
      id: 'mino-project',
      hidden: true,
      hiddenAt: '2026-06-11T00:00:00.000Z',
    });
    expect(result?.projects[0]).toEqual(result?.project);
    expect(result?.projects[1]).toEqual(other);
  });
});

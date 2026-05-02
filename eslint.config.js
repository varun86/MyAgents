import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import eslintComments from 'eslint-plugin-eslint-comments';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  {
    // Additional ignore patterns for build output and bundled resources
    ignores: ['**/out/**', '**/dist/**', '**/.vite/**', '**/coverage/**', '**/.eslintcache', 'bundled-skills/**', '**/sdk-shim/**']
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    plugins: {
      'eslint-comments': eslintComments,
      react,
      'react-hooks': reactHooks
    }
  },
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  // Pit-of-success guard: bare imports of `listen` from `@tauri-apps/api/event`
  // leak the Tauri-side listener if the component unmounts during the
  // `await listen(...)` race window. `listenWithCleanup` from
  // `@/utils/tauriListen` encapsulates the correct teardown pattern (pre-await
  // abort, handler-time abort, post-await unlisten, auto-cleanup on signal).
  // Files that legitimately need bare `listen` (`SseConnection.ts`, the helper
  // itself, the helper test, and `TerminalPanel.tsx` whose listener lifecycle
  // is intentionally decoupled from the React effect) are exempted via
  // `ignores`. `import type { UnlistenFn }` is fine — type-only imports erase.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: [
      'src/renderer/utils/tauriListen.ts',
      'src/renderer/utils/tauriListen.test.ts',
      'src/renderer/api/SseConnection.ts',
      'src/renderer/components/TerminalPanel.tsx',
    ],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/event',
              importNames: ['listen'],
              message: "Use `listenWithCleanup` from '@/utils/tauriListen' instead — bare `await listen(...)` leaks the Tauri listener if the component unmounts mid-registration. See `tauriListen.ts` doc-comment.",
              allowTypeImports: true,
            },
          ],
        },
      ],
      // NOTE: `no-restricted-syntax` for dynamic-import detection lives in
      // the renderer block below (~line 130), MERGED with the Phase E sidecar
      // endpoint selectors. Splitting it across two config blocks doesn't
      // work — Flat Config's later-block-wins semantics meant the renderer
      // block's `no-restricted-syntax` wiped out anything we set here, so a
      // dynamic `import('@tauri-apps/api/event').then(({ listen }) => …)`
      // slipped through the guard. (Codex review of this migration caught
      // exactly this — 4 such callsites had been quietly bypassed.)
    },
  },
  // Renderer process (Browser + React environment)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off', // Using TypeScript for prop validation
      // Phase E (PRD 0.2.7): the renderer MUST NOT reach the deleted
      // sidecar workspace-IO endpoints. Workspace file ops go through Rust
      // `cmd_workspace_*` invokes via `useWorkspaceFileService`. Each
      // banned endpoint is matched via a `Literal[value=...]` selector
      // (esquery's regex literals are flaky in flat-config mode, so we
      // enumerate). Comments aren't `Literal` nodes, so red-line history
      // can still reference these strings in CLAUDE.md / PRD docs.
      'no-restricted-syntax': [
        'error',
        // Dynamic-import guard for `@tauri-apps/api/event`. Catches
        // `import('@tauri-apps/api/event').then(({ listen }) => …)` which
        // bypasses the static `no-restricted-imports` rule above — that
        // rule only sees named imports in `ImportDeclaration` nodes. The
        // dynamic-import form ALSO needs to be locked down to seal the
        // pit-of-success: 4 such callsites bypassed the migration before
        // this selector was added. (Codex review CRIT-1 of the migration.)
        // Note: this matches ALL dynamic imports of the package, including
        // `emit`-only access. Migrate any legitimate `emit` callsite to a
        // static `import { emit } from '@tauri-apps/api/event'` (no leak
        // risk because emit doesn't subscribe).
        {
          selector: "ImportExpression > Literal[value='@tauri-apps/api/event']",
          message: "Dynamic `import('@tauri-apps/api/event')` is forbidden — bypasses the static `listen` ban. Use `listenWithCleanup` from '@/utils/tauriListen' for subscriptions, or a static `import { emit } from '@tauri-apps/api/event'` for one-shot dispatch.",
        },
        ...[
          '/api/files/import-base64',
          '/api/files/copy',
          '/api/files/read-as-base64',
          '/api/files/add-gitignore',
          '/api/commands',
          '/api/git/branch',
          '/api/claude-md',
          '/agent/dir',
          '/agent/dir/expand',
          '/agent/file',
          '/agent/download',
          '/agent/import',
          '/agent/new-file',
          '/agent/new-folder',
          '/agent/rename',
          '/agent/delete',
          '/agent/move',
          '/agent/open-in-finder',
          '/agent/open-with-default',
          '/agent/open-path',
          '/agent/search-files',
          '/agent/check-paths',
          '/agent/save-file'
        ].map((endpoint) => ({
          selector: `Literal[value=${JSON.stringify(endpoint)}]`,
          message: `Phase E (PRD 0.2.7): sidecar HTTP endpoint '${endpoint}' was deleted. Workspace file IO must go through Rust cmd_workspace_* invokes via useWorkspaceFileService. See CLAUDE.md red-line.`
        }))
      ]
    }
  },
  // Global rules for all files
  {
    rules: {
      // TypeScript rules
      'no-undef': 'off', // TypeScript handles this
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // Prevent disabling no-explicit-any via inline comments — it hides real
      // type bugs behind `any`. Ban list extends below for ESM-targeted files
      // (which is everything except `src/cli/**`).
      'eslint-comments/no-restricted-disable': ['error', '@typescript-eslint/no-explicit-any']
    }
  },
  // ESM-targeted files (everything except the CJS-bundled CLI): forbid
  // `// eslint-disable-next-line @typescript-eslint/no-require-imports`.
  //
  // Why: bare `require()` in an ESM file throws `ReferenceError: require is
  // not defined` at runtime. The Bun→Node v0.2.0 migration accumulated 6+
  // sites where developers reached for `require()` (probably copy-paste from
  // legacy CJS code) and silenced the lint with a disable comment. Each one
  // was a latent crash waiting for the right code path. The MCP playwright
  // "initialization failed: require is not defined" regression in v0.2.0 was
  // caused by exactly this. ESM files MUST use static `import` or
  // `await import()` — never `require()`.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['src/cli/**'],
    rules: {
      'eslint-comments/no-restricted-disable': [
        'error',
        '@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-require-imports'
      ]
    }
  },
  // CLI is bundled by esbuild with `--format=cjs` (see package.json:build:cli),
  // so `require()` runs in a real CJS context after bundling. Disable the rule
  // entirely for CLI files — relying on disable-next-line comments would force
  // every `require()` call site to carry boilerplate, and (per Codex review)
  // doesn't actually constitute a true exemption since the underlying rule
  // would still fire if a contributor forgot the comment.
  {
    files: ['src/cli/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // Structural guard: builtin MCP tool files MUST NOT eager-import the SDK
  // or zod at module top (value imports only — `import type { ... }` is
  // erased at compile time and is fine). Value imports from these modules
  // must be loaded inside `createXxxServer()` via `await import(...)` so
  // the Sidecar cold-start singleton-creation tax (~500-1000ms) stays
  // deferred. Enforces the "Pit of success" convention codified in
  // CLAUDE.md 补充禁止事项 and builtin-mcp-meta.ts header.
  //
  // Uses @typescript-eslint/no-restricted-imports (not the base rule) so
  // that `allowTypeImports: true` lets us keep type-only imports zero-cost.
  {
    files: ['src/server/tools/*.ts'],
    ignores: ['src/server/tools/builtin-mcp-registry.ts', 'src/server/tools/builtin-mcp-meta.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/claude-agent-sdk',
              message: "Value-import inside createXxxServer() via `await import('@anthropic-ai/claude-agent-sdk')`. `import type { ... }` at module top is OK. See CLAUDE.md 补充禁止事项.",
              allowTypeImports: true
            },
            {
              name: 'zod',
              message: "Value-import inside createXxxServer() via `await import('zod/v4')`. `import type { ... }` at module top is OK.",
              allowTypeImports: true
            },
            {
              name: 'zod/v4',
              message: "Value-import inside createXxxServer() via `await import('zod/v4')`. `import type { ... }` at module top is OK.",
              allowTypeImports: true
            }
          ]
        }
      ]
    }
  }
);

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function resolveSpawnInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  const fileExists = options.fileExists ?? existsSync;
  if (platform === 'win32' && (command === 'npm' || command === 'npx')) {
    const cliName = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    const cliPath = join(dirname(nodeExecPath), 'node_modules', 'npm', 'bin', cliName);
    if (fileExists(cliPath)) {
      return {
        command: nodeExecPath,
        args: [cliPath, ...args],
        displayCommand: command,
        displayArgs: args,
      };
    }
  }
  return {
    command,
    args,
    displayCommand: command,
    displayArgs: args,
  };
}

export function formatCommandFailure(command, args, result) {
  const renderedArgs = args.map((arg) => (
    /password|private[-_]?key|secret|token/i.test(arg) ? '<redacted>' : arg
  ));
  return [
    `Command failed: ${command} ${renderedArgs.join(' ')}`,
    result.error?.message,
    result.stdout?.trim(),
    result.stderr?.trim(),
  ].filter(Boolean).join('\n');
}

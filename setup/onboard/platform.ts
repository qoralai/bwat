// Which computer the setup page runs on, as the names a bwat:os block takes (flow.ts): the
// page shows a block when one of its names is this computer's.
import { readFileSync } from 'node:fs';

export const PLATFORMS = {
  mac: 'macOS',
  'apple-silicon': 'an Apple-silicon Mac',
  windows: 'Windows',
  wsl: 'WSL',
  linux: 'Linux',
} as const;

export type Platform = keyof typeof PLATFORMS;

/** This computer's names. WSL is Windows too: Docker Desktop lives on Windows' side. */
export function platformTags(platform: string = process.platform, arch: string = process.arch, version = procVersion()): Platform[] {
  if (platform === 'darwin') return arch === 'arm64' ? ['mac', 'apple-silicon'] : ['mac'];
  if (platform === 'win32') return ['windows'];
  if (/microsoft/i.test(version)) return ['windows', 'wsl'];
  return ['linux'];
}

function procVersion(): string {
  try { return readFileSync('/proc/version', 'utf8'); } catch { return ''; }
}

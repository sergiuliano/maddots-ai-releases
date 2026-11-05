import { HelperError } from './config.js';

export type HelperPlatform = 'darwin' | 'linux';

/** Each supported operating system has an explicit backend. */
export function helperPlatform(platform: NodeJS.Platform = process.platform): HelperPlatform {
  if (platform === 'darwin' || platform === 'linux') return platform;
  throw new HelperError('PLATFORM_UNSUPPORTED', 'The helper supports macOS and Linux. This operating system is not supported.');
}

export function helperOs(platform: NodeJS.Platform = process.platform): 'macos' | 'linux' {
  return helperPlatform(platform) === 'darwin' ? 'macos' : 'linux';
}

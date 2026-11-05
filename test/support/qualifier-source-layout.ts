import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';

// The exporter relocates runner URLs into src/runner. Derive the layout from
// that transformation, so a missing source-checkout probe still fails its tests.
const runner = relative(fileURLToPath(new URL('../../', import.meta.url)),
  fileURLToPath(new URL('../../src/runner/', import.meta.url))).split('\\').join('/');

export const qualifierSourceOnlySkip = runner === 'src/runner'
  ? 'founder-installed qualification probe is source-checkout only' : false;

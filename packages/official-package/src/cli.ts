import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

import {
  inspectOfficialPackage,
  locateAsar,
  prepareOfficialPackage,
  verifyPreparedRelease,
} from './index.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    app: { type: 'string', default: '/Applications/ChatGPT.app' },
    asar: { type: 'string' },
    output: { type: 'string', default: '.official/releases' },
    manifest: {
      type: 'string',
      default:
        process.env.OFFICIAL_SOURCE_MANIFEST ??
        process.env.SOURCE_MANIFEST ??
        '.official/releases/26.727.51351/qualification/source-manifest.json',
    },
  },
});

const command = positionals[0];
const asarPath = values.asar ?? locateAsar(values.app);

switch (command) {
  case 'inspect': {
    const manifest = await inspectOfficialPackage({ asarPath });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    break;
  }
  case 'prepare':
  case 'extract': {
    const manifest = await prepareOfficialPackage({
      asarPath,
      outputRoot: resolve(values.output),
    });
    process.stdout.write(
      `${JSON.stringify({
        version: manifest.package.version,
        asarSha256: manifest.package.asarSha256,
        rendererTreeSha256: manifest.renderer.treeSha256,
        hostTreeSha256: manifest.host.treeSha256,
        rendererRoot: manifest.renderer.root,
        hostRoot: manifest.host.root,
      })}\n`,
    );
    break;
  }
  case 'verify': {
    const manifest = verifyPreparedRelease(resolve(values.manifest));
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        version: manifest.package.version,
        rendererTreeSha256: manifest.renderer.treeSha256,
        hostTreeSha256: manifest.host.treeSha256,
      })}\n`,
    );
    break;
  }
  default:
    throw new Error('usage: official-package <inspect|prepare|verify> [options]');
}

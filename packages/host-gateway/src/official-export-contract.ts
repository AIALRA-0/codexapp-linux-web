import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type QualifiedOfficialVersion = '26.721.81911' | '26.727.51351' | '26.730.61639';

const DESKTOP_STATE_EXPORTS = {
  '26.721.81911': {
    E: 'E',
    Bl: 'Bl',
    Ht: 'Ht',
    Gt: 'Gt',
    Wt: 'Wt',
    Cr: 'Cr',
    Di: 'Di',
    Er: 'Er',
    Gr: 'Gr',
    Tr: 'Tr',
    Vr: 'Vr',
    qr: 'qr',
    br: 'br',
    kr: 'kr',
    Sr: 'Sr',
    xr: 'xr',
    zl: 'zl',
    Jl: 'Jl',
    Ql: 'Ql',
    Xl: 'Xl',
    Zl: 'Zl',
    rn: 'rn',
    wr: 'wr',
    _r: '_r',
    Ar: 'Ar',
    yr: 'yr',
    vr: 'vr',
    Ur: 'Ur',
    T: 'T',
    w: 'w',
    C: 'C',
    S: 'S',
    Kr: 'Kr',
    Wr: 'Wr',
    Hr: 'Hr',
    Rr: 'Rr',
    zo: 'zo',
    Rt: 'Rt',
    Lt: 'Lt',
    on: 'on',
    Sc: 'Sc',
    xc: 'xc',
    Jr: 'Jr',
    autoDenyPermissions: 'sn',
  },
  '26.727.51351': {
    E: 'b',
    Bl: 'Pc',
    Ht: 'Nt',
    Gt: 'It',
    Wt: 'Ft',
    Cr: 'pr',
    Di: 'gi',
    Er: 'gr',
    Gr: 'Fr',
    Tr: 'hr',
    Vr: 'jr',
    qr: 'Lr',
    br: 'ur',
    kr: 'yr',
    Sr: 'fr',
    xr: 'dr',
    zl: 'Nc',
    Jl: 'Bc',
    Ql: 'Uc',
    Xl: 'Vc',
    Zl: 'Hc',
    rn: 'Xt',
    wr: 'mr',
    _r: 'sr',
    Ar: 'br',
    yr: 'lr',
    vr: 'cr',
    Ur: 'Nr',
    T: 'y',
    w: 'v',
    C: '_',
    S: 'g',
    Kr: 'Ir',
    Wr: 'Pr',
    Hr: 'Mr',
    Rr: 'Or',
    zo: 'lo',
    Rt: 'kt',
    Lt: 'Ot',
    on: '$t',
    Sc: '_s',
    xc: 'gs',
    Jr: 'Rr',
    autoDenyPermissions: 'en',
  },
  '26.730.61639': {
    E: 'b',
    Bl: 'wc',
    Ht: 'Nt',
    Gt: 'It',
    Wt: 'Ft',
    Cr: 'or',
    Di: 'li',
    Er: 'lr',
    Gr: 'Or',
    Tr: 'cr',
    Vr: 'wr',
    qr: 'Ar',
    br: 'rr',
    kr: 'fr',
    Sr: 'ar',
    xr: 'ir',
    zl: 'Cc',
    Jl: 'Ac',
    Ql: 'Nc',
    Xl: 'jc',
    Zl: 'Mc',
    rn: 'qt',
    wr: 'sr',
    _r: 'er',
    Ar: 'pr',
    yr: 'nr',
    vr: 'tr',
    Ur: 'Er',
    T: 'y',
    w: 'v',
    C: '_',
    S: 'g',
    Kr: 'kr',
    Wr: 'Dr',
    Hr: 'Tr',
    Rr: 'xr',
    zo: 'no',
    Rt: 'kt',
    Lt: 'Ot',
    on: 'Xt',
    Sc: 'us',
    xc: 'ls',
    Jr: 'jr',
    autoDenyPermissions: 'Zt',
  },
} as const satisfies Record<QualifiedOfficialVersion, Record<string, string>>;

const GIT_EXPORTS = {
  '26.721.81911': {
    attachRpc: 'At',
    githubService: 'D',
    gitManager: 'F',
    localExecutionHostRpc: 'I',
  },
  '26.727.51351': {
    attachRpc: 'St',
    githubService: 'x',
    gitManager: 'O',
    localExecutionHostRpc: 'k',
  },
  '26.730.61639': {
    attachRpc: 'St',
    githubService: 'x',
    gitManager: 'O',
    localExecutionHostRpc: 'k',
  },
} as const satisfies Record<QualifiedOfficialVersion, Record<string, string>>;

const DEVELOPER_INSTRUCTIONS_EXPORTS = {
  '26.721.81911': 'an',
  '26.727.51351': 'Qt',
  '26.730.61639': 'Yt',
} as const satisfies Record<QualifiedOfficialVersion, string>;

export function readQualifiedOfficialVersion(sourceRoot: string): QualifiedOfficialVersion {
  const packagePath = join(resolve(sourceRoot), 'package.json');
  const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
  if (
    parsed.version !== '26.721.81911' &&
    parsed.version !== '26.727.51351' &&
    parsed.version !== '26.730.61639'
  ) {
    throw new Error(`unqualified official package version: ${String(parsed.version)}`);
  }
  return parsed.version;
}

export function officialDesktopStateExportNames(
  version: QualifiedOfficialVersion,
): (typeof DESKTOP_STATE_EXPORTS)[QualifiedOfficialVersion] {
  return DESKTOP_STATE_EXPORTS[version];
}

export function officialGitExportNames(
  version: QualifiedOfficialVersion,
): (typeof GIT_EXPORTS)[QualifiedOfficialVersion] {
  return GIT_EXPORTS[version];
}

export function officialDeveloperInstructionsExportName(version: QualifiedOfficialVersion): string {
  return DEVELOPER_INSTRUCTIONS_EXPORTS[version];
}

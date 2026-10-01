import type { Platform } from '/@/shared/signalpath';

/**
 * Desktop platform for signalpath policy decisions. The mpv subsystem only
 * runs under Electron; a non-Electron call falls through to 'linux', which
 * carries no AO pins.
 */
export function getPlatform(): Platform {
    const utils = window.api?.utils;
    if (utils?.isMacOS?.()) {
        return 'darwin';
    }
    return utils?.isWindows?.() ? 'win32' : 'linux';
}

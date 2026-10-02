import type { AnalysisAvailability } from '/@/shared/analysis';

import path from 'node:path';

import { runProcess } from './process';

const COMMON_BINARY_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const PROBE_TIMEOUT_MS = 5_000;

/** True only when the binary exists, is executable, and answers `-version`. */
export async function probeBinary(binary: string): Promise<boolean> {
    try {
        return (
            (await runProcess(binary, ['-version'], AbortSignal.timeout(PROBE_TIMEOUT_MS))).code ===
            0
        );
    } catch {
        // Spawn failure (ENOENT, not executable) or timeout: not a usable binary.
        return false;
    }
}

/**
 * ffmpeg is a system dependency, not a bundled one. Absolute Homebrew paths
 * cover macOS apps launched from Finder, whose PATH has no Homebrew; /usr/bin
 * and the bare name cover Linux/Windows. A candidate only counts if it
 * actually runs, so a broken symlink or wrong-arch binary falls through.
 */
export async function resolveFfmpegBinaries(): Promise<AnalysisAvailability> {
    const [ffmpegPath, ffprobePath] = await Promise.all([
        resolveBinary('ffmpeg'),
        resolveBinary('ffprobe'),
    ]);

    if (!ffmpegPath) {
        return { available: false, reason: 'missing-ffmpeg' };
    }
    if (!ffprobePath) {
        return { available: false, reason: 'missing-ffprobe' };
    }

    return { available: true, ffmpegPath, ffprobePath };
}

async function resolveBinary(name: 'ffmpeg' | 'ffprobe'): Promise<null | string> {
    for (const dir of COMMON_BINARY_DIRS) {
        const candidate = path.join(dir, name);
        if (await probeBinary(candidate)) {
            return candidate;
        }
    }

    return (await probeBinary(name)) ? name : null;
}

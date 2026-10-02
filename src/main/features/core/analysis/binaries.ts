import type { AnalysisAvailability } from '/@/shared/analysis';

import { access } from 'node:fs/promises';
import path from 'node:path';

import { runProcess } from './process';

const COMMON_BINARY_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/**
 * ffmpeg is a system dependency, not a bundled one. Absolute Homebrew paths
 * cover macOS apps launched from Finder, whose PATH has no Homebrew; the bare
 * name covers Windows/Linux and any shell with a real PATH.
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

async function fileExists(filePath: string): Promise<boolean> {
    return access(filePath).then(
        () => true,
        () => false,
    );
}

async function resolveBinary(name: 'ffmpeg' | 'ffprobe'): Promise<null | string> {
    for (const dir of COMMON_BINARY_DIRS) {
        const candidate = path.join(dir, name);
        if (await fileExists(candidate)) {
            return candidate;
        }
    }

    return (await runs(name)) ? name : null;
}

async function runs(binary: string): Promise<boolean> {
    return (await runProcess(binary, ['-version'])).code === 0;
}

import type { AnalysisAvailability } from '/@/shared/analysis';

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

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

    return {
        available: true,
        ffmpegPath,
        ffprobePath,
        version: await readFfmpegVersion(ffmpegPath),
    };
}

async function fileExists(filePath: string): Promise<boolean> {
    return access(filePath).then(
        () => true,
        () => false,
    );
}

async function readFfmpegVersion(ffmpegPath: string): Promise<null | string> {
    const result = await runCapture(ffmpegPath, ['-version']);
    const match = /^ffmpeg version (\S+)/.exec(result.stdout);
    return match?.[1] ?? null;
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

function runCapture(
    binary: string,
    args: string[],
): Promise<{ code: null | number; stdout: string }> {
    return new Promise((resolve) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.on('error', () => resolve({ code: null, stdout }));
        child.on('close', (code) => resolve({ code, stdout }));
    });
}

async function runs(binary: string): Promise<boolean> {
    return (await runCapture(binary, ['-version'])).code === 0;
}

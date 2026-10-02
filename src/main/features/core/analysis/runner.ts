import type { AnalysisAvailability, AnalysisRequest, AnalysisResponse } from '/@/shared/analysis';

import { net } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import log from '/@/main/logger';
import {
    buildFfmpegAnalysisArgs,
    buildFfprobeAnalysisArgs,
    deriveAnalysisResult,
    parseAstatsOverall,
    parseEbur128Summary,
    parseFfprobeJson,
    parseRolloffValues,
    summarizeRolloff,
} from '/@/shared/analysis';

interface ProcessResult {
    code: null | number;
    stderr: string;
    stdout: string;
}

/**
 * One offline analysis run: download the raw stream to a temp file, sanity
 * check it with ffprobe, measure with one ffmpeg pass, and parse the output.
 * Aborting `signal` cancels the download and kills any running child; the temp
 * file is removed on every exit path.
 */
export async function runTrackAnalysis(
    request: AnalysisRequest,
    availability: Extract<AnalysisAvailability, { available: true }>,
    signal: AbortSignal,
): Promise<AnalysisResponse> {
    const startedAt = Date.now();
    let workDir: null | string = null;

    try {
        workDir = await mkdtemp(path.join(tmpdir(), 'feishin-analysis-'));
        const sourcePath = path.join(workDir, 'source');
        await downloadToFile(request.url, sourcePath, signal);

        const probe = await runProcess(
            availability.ffprobePath,
            buildFfprobeAnalysisArgs(sourcePath),
            signal,
        );
        if (probe.code !== 0) {
            return {
                message: `ffprobe exited with code ${probe.code ?? 'signal'}`,
                status: 'error',
            };
        }
        const source = parseFfprobeJson(probe.stdout);
        if (!source) {
            return { message: 'ffprobe reported no audio stream', status: 'error' };
        }

        const stats = await runProcess(
            availability.ffmpegPath,
            buildFfmpegAnalysisArgs(sourcePath),
            signal,
        );
        if (stats.code !== 0) {
            return {
                message: `ffmpeg exited with code ${stats.code ?? 'signal'}`,
                status: 'error',
            };
        }

        const result = deriveAnalysisResult({
            analyzedAt: new Date().toISOString(),
            astats: parseAstatsOverall(stats.stderr),
            ebur128: parseEbur128Summary(stats.stderr),
            rolloff: summarizeRolloff(parseRolloffValues(stats.stdout)),
            source,
        });
        log.info('analysis finished', {
            durationMs: Date.now() - startedAt,
            label: request.label ?? 'track',
        });
        return { result, status: 'ok' };
    } catch (error) {
        if (signal.aborted) {
            return { status: 'cancelled' };
        }
        log.warn('analysis failed', {
            error: error instanceof Error ? error.message : String(error),
            label: request.label ?? 'track',
        });
        return {
            message: error instanceof Error ? error.message : 'unknown error',
            status: 'error',
        };
    } finally {
        if (workDir) {
            await rm(workDir, { force: true, recursive: true }).catch(() => {
                // Temp cleanup is best-effort; the OS reclaims leftovers.
            });
        }
    }
}

async function downloadToFile(url: string, filePath: string, signal: AbortSignal): Promise<void> {
    const response = await net.fetch(url, { signal });
    if (!response.ok) {
        throw new Error(`download failed with HTTP ${response.status}`);
    }
    if (!response.body) {
        throw new Error('download returned an empty body');
    }

    await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(filePath),
    );
}

function runProcess(binary: string, args: string[], signal: AbortSignal): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr, stdout }));
    });
}

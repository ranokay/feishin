import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FixtureSpec } from '../fixtures/audio-fixtures';

import { runProcess } from '../../src/main/features/core/analysis/process';
import { policyStartupConfig } from '../../src/shared/signalpath';
import { writeFlacFixture, writeWavFixture } from '../fixtures/audio-fixtures';
import { MpvTestProcess } from './mpv-test-process';

export interface BitTransparencyCell {
    container: 'flac' | 'wav';
    spec: FixtureSpec;
}

export interface PcmComparison {
    detail?: string;
    matched: boolean;
}

/**
 * Every depth/rate combination a strict chain must decode without alteration.
 * FLAC stops at 24-bit because 32-bit FLAC is not a streamable subset.
 */
const BIT_TRANSPARENCY_DEPTHS = [16, 24, 32] as const;
const BIT_TRANSPARENCY_RATES = [44100, 48000, 96000, 192000] as const;

export interface BitTransparencyCellResult {
    detail?: string;
    label: string;
    matched: boolean;
}

export interface BitTransparencyReportInput {
    results: readonly BitTransparencyCellResult[];
    sensitivity: BitTransparencySensitivityResult;
    versions: BitTransparencyVersions;
}

export interface BitTransparencySelfTestInput {
    ffmpegBinary: string;
    mpvBinary: string;
    workDir: string;
}

export interface BitTransparencySelfTestOutcome {
    report: string;
    results: BitTransparencyCellResult[];
    sensitivity: BitTransparencySensitivityResult;
    versions: BitTransparencyVersions;
}

export interface BitTransparencySensitivityResult {
    detail?: string;
    detected: boolean;
}

export interface BitTransparencyVersions {
    ffmpeg: string;
    mpv: string;
    platform: string;
}

export function bitTransparencyCellLabel(cell: BitTransparencyCell): string {
    const channelLabel = cell.spec.channels === 1 ? 'mono' : 'stereo';
    return `${cell.container} ${cell.spec.bitDepth}-bit ${cell.spec.sampleRate} Hz ${channelLabel}`;
}

export function bitTransparencyMatrix(): BitTransparencyCell[] {
    const cells: BitTransparencyCell[] = [];
    for (const container of ['wav', 'flac'] as const) {
        for (const sampleRate of BIT_TRANSPARENCY_RATES) {
            for (const bitDepth of BIT_TRANSPARENCY_DEPTHS) {
                if (container === 'flac' && bitDepth === 32) {
                    continue;
                }
                cells.push({
                    container,
                    spec: {
                        bitDepth,
                        channels: 2,
                        durationSec: 0.5,
                        frequencyHz: 1000,
                        kind: 'sine',
                        sampleRate,
                    },
                });
            }
        }
    }
    return cells;
}

/**
 * Byte-compares a reference PCM decode against an mpv render. Raw PCM has no
 * header, so any difference is a real sample-data difference.
 */
export function comparePcm(reference: Buffer, rendered: Buffer): PcmComparison {
    const commonLength = Math.min(reference.length, rendered.length);
    for (let offset = 0; offset < commonLength; offset++) {
        if (reference.readUInt8(offset) !== rendered.readUInt8(offset)) {
            return {
                detail: [
                    `first differing byte ${offset}: reference ${toHex(reference.readUInt8(offset))}, rendered ${toHex(rendered.readUInt8(offset))}`,
                    ...(reference.length === rendered.length
                        ? []
                        : [lengthMismatch(reference, rendered)]),
                ].join('; '),
                matched: false,
            };
        }
    }
    if (reference.length === rendered.length) {
        return { matched: true };
    }
    return { detail: lengthMismatch(reference, rendered), matched: false };
}

export function formatBitTransparencyReport(input: BitTransparencyReportInput): string {
    const { results, sensitivity, versions } = input;
    const passed = results.filter((result) => result.matched).length;
    const failed = results.length - passed;

    const cellLines = results.map(
        (result) =>
            `${result.matched ? 'PASS' : 'FAIL'} ${result.label}${result.detail ? `: ${result.detail}` : ''}`,
    );
    const sensitivityLine = sensitivity.detected
        ? `Sensitivity (EQ injected): detected as expected${sensitivity.detail ? ` (${sensitivity.detail})` : ''}`
        : 'Sensitivity (EQ injected): not detected';

    return [
        'Bit-transparency self-test',
        '',
        `mpv:      ${versions.mpv}`,
        `ffmpeg:   ${versions.ffmpeg}`,
        `platform: ${versions.platform}`,
        '',
        ...cellLines,
        '',
        sensitivityLine,
        `Cells: ${passed} passed, ${failed} failed`,
        `Result: ${failed === 0 && sensitivity.detected ? 'PASS' : 'FAIL'}`,
    ].join('\n');
}

function lengthMismatch(reference: Buffer, rendered: Buffer): string {
    return `length mismatch: reference ${reference.length} bytes, rendered ${rendered.length} bytes`;
}

function toHex(byte: number): string {
    return `0x${byte.toString(16).padStart(2, '0')}`;
}

const SENSITIVITY_AF = 'equalizer=f=1000:t=q:w=1:g=6';
const SENSITIVITY_CELL_KEY = 'wav-24-96000';

// Conflicting values the strict pins must override. A fresh mpv already
// defaults to transparent behavior, so seeding this baseline first is what
// makes the matrix fail if a pin stops being applied.
const NON_TRANSPARENT_BASELINE: Record<string, unknown> = {
    af: 'equalizer=f=500:t=q:w=1:g=3',
    'audio-samplerate': 48000,
    'gapless-audio': 'yes',
    replaygain: 'track',
    speed: 1.25,
    volume: 50,
};

/**
 * Software bit-transparency self-test: renders every matrix cell through a
 * strict-configured mpv (`--ao=pcm`) and byte-compares it against an ffmpeg
 * reference decode of the same fixture. Hardware stays out of the loop; a
 * seeded non-transparent baseline must be neutralized by the strict pins, and
 * an EQ-injected render proves the comparison is sensitive to chain changes.
 */
export async function runBitTransparencySelfTest(
    input: BitTransparencySelfTestInput,
): Promise<BitTransparencySelfTestOutcome> {
    const versions: BitTransparencyVersions = {
        ffmpeg: await readFirstLine(input.ffmpegBinary, ['-version']),
        mpv: await readFirstLine(input.mpvBinary, ['--version']),
        platform: `${process.platform} ${os.arch()} ${os.release()}`,
    };

    const cells = bitTransparencyMatrix();
    const results: BitTransparencyCellResult[] = [];
    for (const cell of cells) {
        const key = cellKey(cell);
        const fixturePath =
            cell.container === 'flac'
                ? await writeFlacFixture(input.workDir, cell.spec)
                : await writeWavFixture(input.workDir, cell.spec);
        const comparison = await decodeAndRender({
            ffmpegBinary: input.ffmpegBinary,
            fixturePath,
            mpvBinary: input.mpvBinary,
            referencePath: path.join(input.workDir, `${key}.reference.pcm`),
            renderedPath: path.join(input.workDir, `${key}.rendered.pcm`),
        });
        results.push({ label: bitTransparencyCellLabel(cell), ...comparison });
    }

    const sensitivityCell = cells.find((cell) => cellKey(cell) === SENSITIVITY_CELL_KEY);
    if (!sensitivityCell) {
        throw new Error(`sensitivity cell ${SENSITIVITY_CELL_KEY} is missing from the matrix`);
    }
    const sensitivityKey = cellKey(sensitivityCell);
    const sensitivityComparison = await decodeAndRender({
        af: SENSITIVITY_AF,
        ffmpegBinary: input.ffmpegBinary,
        fixturePath: await writeWavFixture(input.workDir, sensitivityCell.spec),
        mpvBinary: input.mpvBinary,
        referencePath: path.join(input.workDir, `${sensitivityKey}.reference.pcm`),
        renderedPath: path.join(input.workDir, `${sensitivityKey}.sensitivity.pcm`),
    });
    const sensitivity: BitTransparencySensitivityResult = {
        detail: sensitivityComparison.detail,
        detected: !sensitivityComparison.matched,
    };

    return {
        report: formatBitTransparencyReport({ results, sensitivity, versions }),
        results,
        sensitivity,
        versions,
    };
}

function cellKey(cell: BitTransparencyCell): string {
    return `${cell.container}-${cell.spec.bitDepth}-${cell.spec.sampleRate}`;
}

async function decodeAndRender(options: {
    af?: string;
    ffmpegBinary: string;
    fixturePath: string;
    mpvBinary: string;
    referencePath: string;
    renderedPath: string;
}): Promise<PcmComparison> {
    const decode = await runProcess(options.ffmpegBinary, [
        '-v',
        'error',
        '-y',
        '-i',
        options.fixturePath,
        '-f',
        's32le',
        '-c:a',
        'pcm_s32le',
        options.referencePath,
    ]);
    if (decode.code !== 0) {
        throw new Error(
            `ffmpeg reference decode of ${path.basename(options.fixturePath)} failed (exit ${decode.code}): ${decode.stderr.trim()}`,
        );
    }

    await renderFixture(options);

    return comparePcm(await readFile(options.referencePath), await readFile(options.renderedPath));
}

async function readFirstLine(binary: string, args: string[]): Promise<string> {
    const result = await runProcess(binary, args);
    const line = result.stdout
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.length > 0);
    if (result.code !== 0 || line === undefined) {
        throw new Error(
            `${binary} ${args.join(' ')} failed to report a version (exit ${result.code}): ${result.stderr.trim()}`,
        );
    }
    return line;
}

async function renderFixture(options: {
    af?: string;
    fixturePath: string;
    mpvBinary: string;
    renderedPath: string;
}): Promise<void> {
    // Mirror the bit-perfect startup config, but replace the platform's
    // hardware AO pin with the software PCM sink. The platform argument only
    // selects that discarded pin, so a fixed one keeps the mirror
    // platform-independent. Both sides of the comparison are raw s32le: the
    // reference decodes to it with ffmpeg, the render forces it with
    // --audio-format, and integer widening to 32-bit is precision-preserving.
    const { runtimeProperties, startupArgs } = policyStartupConfig('bit-perfect', 'linux');
    const args = [
        ...startupArgs.filter((arg) => !arg.startsWith('--ao=')),
        '--ao=pcm',
        '--ao-pcm-waveheader=no',
        `--ao-pcm-file=${options.renderedPath}`,
        '--audio-format=s32',
    ];

    const mpv = new MpvTestProcess({ args, binaryPath: options.mpvBinary });
    try {
        await mpv.start();
        for (const [name, value] of Object.entries(NON_TRANSPARENT_BASELINE)) {
            await mpv.setProperty(name, value);
        }
        for (const [name, value] of Object.entries(runtimeProperties)) {
            await mpv.setProperty(name, value);
        }
        if (options.af) {
            await mpv.setProperty('af', options.af);
        }

        await mpv.request(['loadfile', options.fixturePath]);
        const endFile = await mpv.waitFor({ name: 'end-file', timeoutMs: 15000 });
        if (endFile['reason'] !== 'eof') {
            throw new Error(
                `mpv did not play ${path.basename(options.fixturePath)} to eof: ${JSON.stringify(endFile)}`,
            );
        }
    } finally {
        await mpv.dispose();
    }
}

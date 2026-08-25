import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface FixtureSpec {
    bitDepth: 16 | 24 | 32;
    channels: number;
    durationSec: number;
    frequencyHz?: number;
    kind: 'silence' | 'sine';
    sampleRate: number;
}

let ffmpegAvailability: Promise<null | string> | undefined;

export interface StandardFixtures {
    dir: string;
    wavByFileName: Record<string, string>;
}

export async function createFixtureDirectory(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'feishin-hifi-'));
    await mkdir(dir, { recursive: true });
    return dir;
}

export function fixtureFileName(spec: FixtureSpec, extension: 'flac' | 'wav'): string {
    const kind = spec.kind === 'sine' ? `sine${spec.frequencyHz ?? 1000}` : 'silence';
    return `${kind}_${spec.sampleRate}_${spec.bitDepth}bit_${spec.channels}ch_${spec.durationSec}s.${extension}`;
}

export function generateWav(spec: FixtureSpec): Buffer {
    const bytesPerSample = spec.bitDepth / 8;
    const blockAlign = bytesPerSample * spec.channels;
    const totalFrames = Math.floor(spec.sampleRate * spec.durationSec);
    const dataBytes = totalFrames * blockAlign;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(spec.channels, 22);
    header.writeUInt32LE(spec.sampleRate, 24);
    header.writeUInt32LE(spec.sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(spec.bitDepth, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);

    const frames: Buffer[] = [];
    let sampleCounter = 0;
    for (let frame = 0; frame < totalFrames; frame++) {
        for (let channel = 0; channel < spec.channels; channel++) {
            const value =
                spec.kind === 'sine'
                    ? Math.sin(
                          (2 * Math.PI * sampleCounter * (spec.frequencyHz ?? 1000)) /
                              spec.sampleRate,
                      )
                    : 0;
            frames.push(encodeSample(value, spec.bitDepth));
            sampleCounter++;
        }
    }
    return Buffer.concat([header, ...frames]);
}

export function resolveFfmpegBinary(): Promise<null | string> {
    ffmpegAvailability ??= new Promise((resolve) => {
        execFile('ffmpeg', ['-version'], (error) => {
            resolve(error ? null : 'ffmpeg');
        });
    });
    return ffmpegAvailability;
}

export async function writeFlacFixture(dir: string, spec: FixtureSpec): Promise<string> {
    const ffmpegBinary = await resolveFfmpegBinary();
    if (!ffmpegBinary) {
        throw new Error('ffmpeg not available for FLAC fixture generation');
    }
    const filePath = path.join(dir, fixtureFileName(spec, 'flac'));
    const sampleFmt = spec.bitDepth <= 16 ? 's16' : 's32';
    const input = `${spec.kind}=frequency=${spec.frequencyHz ?? 1000}:duration=${spec.durationSec}:sample_rate=${spec.sampleRate}`;
    const channelLayout =
        spec.channels === 1 ? 'mono' : spec.channels === 2 ? 'stereo' : `${spec.channels}c`;
    await new Promise<void>((resolve, reject) => {
        execFile(
            ffmpegBinary,
            [
                '-v',
                'error',
                '-y',
                '-f',
                'lavfi',
                '-i',
                input,
                '-af',
                `aformat=channel_layouts=${channelLayout}`,
                '-ar',
                String(spec.sampleRate),
                '-sample_fmt',
                sampleFmt,
                filePath,
            ],
            (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            },
        );
    });
    return filePath;
}

export async function writeWavFixture(dir: string, spec: FixtureSpec): Promise<string> {
    const filePath = path.join(dir, fixtureFileName(spec, 'wav'));
    await writeFile(filePath, generateWav(spec));
    return filePath;
}

function encodeSample(value: number, bitDepth: 16 | 24 | 32): Buffer {
    if (bitDepth === 16) {
        const scaled = Math.round(value * 0.5 * 32767);
        const buf = Buffer.alloc(2);
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), 0);
        return buf;
    }
    if (bitDepth === 24) {
        const clamped = Math.max(-8388608, Math.min(8388607, Math.round(value * 0.5 * 8388607)));
        const buf = Buffer.alloc(3);
        buf[0] = clamped & 0xff;
        buf[1] = (clamped >> 8) & 0xff;
        buf[2] = (clamped >> 16) & 0xff;
        return buf;
    }
    const scaled = Math.round(value * 0.5 * 2147483647);
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, scaled)), 0);
    return buf;
}

const STANDARD_WAV_MATRIX: FixtureSpec[] = [
    {
        bitDepth: 16,
        channels: 2,
        durationSec: 1,
        frequencyHz: 1000,
        kind: 'sine',
        sampleRate: 44100,
    },
    {
        bitDepth: 16,
        channels: 2,
        durationSec: 1,
        frequencyHz: 1000,
        kind: 'sine',
        sampleRate: 48000,
    },
    {
        bitDepth: 24,
        channels: 2,
        durationSec: 1,
        frequencyHz: 1000,
        kind: 'sine',
        sampleRate: 96000,
    },
    {
        bitDepth: 24,
        channels: 1,
        durationSec: 1,
        frequencyHz: 500,
        kind: 'sine',
        sampleRate: 192000,
    },
];

export const STANDARD_FLAC_MATRIX: FixtureSpec[] = [
    {
        bitDepth: 16,
        channels: 2,
        durationSec: 1,
        frequencyHz: 1000,
        kind: 'sine',
        sampleRate: 44100,
    },
    {
        bitDepth: 24,
        channels: 2,
        durationSec: 1,
        frequencyHz: 1000,
        kind: 'sine',
        sampleRate: 96000,
    },
];

export async function createStandardFixtures(): Promise<StandardFixtures> {
    const dir = await createFixtureDirectory();
    const wavByFileName: Record<string, string> = {};
    for (const spec of STANDARD_WAV_MATRIX) {
        wavByFileName[fixtureFileName(spec, 'wav')] = await writeWavFixture(dir, spec);
    }
    return { dir, wavByFileName };
}

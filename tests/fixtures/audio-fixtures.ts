import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface FixtureSpec {
    /** Peak fraction of full scale; defaults to 0.5, the historical fixture level. */
    amplitude?: number;
    bitDepth: 16 | 24 | 32;
    channels: number;
    durationSec: number;
    frequencyHz?: number;
    kind: 'silence' | 'sine';
    sampleRate: number;
}

let ffmpegAvailability: Promise<null | string> | undefined;

export interface DsfFixtureSpec {
    /** DSD carrier bit rate in Hz: DSD64 = 2822400, DSD128 = 5644800. */
    carrierRate: number;
    channels: number;
    durationSec: number;
}

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
    const amplitude = spec.amplitude ?? 0.5;
    for (let frame = 0; frame < totalFrames; frame++) {
        for (let channel = 0; channel < spec.channels; channel++) {
            const value =
                spec.kind === 'sine'
                    ? Math.sin(
                          (2 * Math.PI * sampleCounter * (spec.frequencyHz ?? 1000)) /
                              spec.sampleRate,
                      )
                    : 0;
            frames.push(encodeSample(value, spec.bitDepth, amplitude));
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

const DSF_BLOCK_SIZE = 4096;
// 0x69 is the canonical DSD idle/silence byte pattern.
const DSF_SILENCE_BYTE = 0x69;

export interface HdcdFixtureSpec {
    /**
     * Peak fraction of full scale. Peak extend only changes samples at or above
     * 0x5981 (~0.70), so the default deliberately overshoots that threshold.
     */
    amplitude?: number;
    channels: number;
    durationSec: number;
    frequencyHz?: number;
    sampleRate: number;
}

export function dsfFixtureFileName(spec: DsfFixtureSpec): string {
    return `dsd_${spec.carrierRate}_${spec.channels}ch_${spec.durationSec}s.dsf`;
}

/**
 * Writes a minimal DSF (DSD Stream File) by hand: the format is simple enough
 * that no encoder is needed, and ffmpeg's dsf demuxer only needs the DSD/fmt
 * chunks plus channel-interleaved 4096-byte blocks (libavformat/dsfdec.c).
 */
export function generateDsf(spec: DsfFixtureSpec): Buffer {
    const blocks = Math.max(
        1,
        Math.round((spec.durationSec * spec.carrierRate) / 8 / DSF_BLOCK_SIZE),
    );
    const bytesPerChannel = blocks * DSF_BLOCK_SIZE;
    const sampleCount = bytesPerChannel * 8;
    const dataBytes = bytesPerChannel * spec.channels;
    const totalSize = 28 + 52 + 12 + dataBytes;

    const header = Buffer.alloc(80);
    header.write('DSD ', 0, 'ascii');
    header.writeBigUInt64LE(28n, 4);
    header.writeBigUInt64LE(BigInt(totalSize), 12);
    header.writeBigUInt64LE(0n, 20); // no metadata pointer
    header.write('fmt ', 28, 'ascii');
    header.writeBigUInt64LE(52n, 32);
    header.writeUInt32LE(1, 40); // format version
    header.writeUInt32LE(0, 44); // format id: DSD raw
    header.writeUInt32LE(spec.channels === 1 ? 1 : 2, 48); // channel type
    header.writeUInt32LE(spec.channels, 52);
    header.writeUInt32LE(spec.carrierRate, 56);
    header.writeUInt32LE(1, 60); // 1 = least significant bit first
    header.writeBigUInt64LE(BigInt(sampleCount), 64);
    header.writeUInt32LE(DSF_BLOCK_SIZE, 72);
    header.writeUInt32LE(0, 76); // reserved

    const dataHeader = Buffer.alloc(12);
    dataHeader.write('data', 0, 'ascii');
    dataHeader.writeBigUInt64LE(BigInt(12 + dataBytes), 4);

    const silenceBlock = Buffer.alloc(DSF_BLOCK_SIZE, DSF_SILENCE_BYTE);
    const blocksPerChannel: Buffer[] = [];
    for (let index = 0; index < blocks * spec.channels; index++) {
        blocksPerChannel.push(silenceBlock);
    }
    return Buffer.concat([header, dataHeader, ...blocksPerChannel], totalSize);
}

export async function writeDsfFixture(dir: string, spec: DsfFixtureSpec): Promise<string> {
    const filePath = path.join(dir, dsfFixtureFileName(spec));
    await writeFile(filePath, generateDsf(spec));
    return filePath;
}

/** 16-bit magnitude at/above which the hdcd filter maps samples through peaktab. */
export const HDCD_PEAK_EXTEND_LEVEL = 0x5981;

const HDCD_SYNC_A = 0x7e0fa005n;
const HDCD_WINDOW_MASK = (1n << 32n) - 1n;

/**
 * Writes a 16-bit WAV carrying one valid HDCD format-A packet with peak
 * extension enabled and 0 dB target gain. ffmpeg exposes no HDCD encoder, so
 * the packet is synthesized from libavfilter's detector: the filter collects
 * sample LSBs into a 32-bit window, applies `w ^ w>>5 ^ w>>23`, and looks for
 * the sync pattern plus an 8-bit control word. Inverting that transform yields
 * the exact LSB stream the detector accepts (verified against FFmpeg 9.0.2).
 */
export function generateHdcdWav(spec: HdcdFixtureSpec): Buffer {
    const wav = generateWav({
        amplitude: spec.amplitude ?? 0.92,
        bitDepth: 16,
        channels: spec.channels,
        durationSec: spec.durationSec,
        frequencyHz: spec.frequencyHz ?? 1000,
        kind: 'sine',
        sampleRate: spec.sampleRate,
    });

    const packetBits = hdcdPacketBits();
    const totalFrames = Math.floor(spec.sampleRate * spec.durationSec);
    for (let frame = 0; frame < totalFrames; frame++) {
        const bit = packetBits[frame] ?? 0;
        for (let channel = 0; channel < spec.channels; channel++) {
            const offset = 44 + (frame * spec.channels + channel) * 2;
            const value = wav.readInt16LE(offset);
            wav.writeInt16LE((value & ~1) | bit, offset);
        }
    }
    return wav;
}

export function hdcdFixtureFileName(spec: HdcdFixtureSpec): string {
    const frequency = spec.frequencyHz ?? 1000;
    return `hdcd_sine${frequency}_${spec.sampleRate}_${spec.channels}ch_${spec.durationSec}s.wav`;
}

export async function writeHdcdWavFixture(dir: string, spec: HdcdFixtureSpec): Promise<string> {
    const filePath = path.join(dir, hdcdFixtureFileName(spec));
    await writeFile(filePath, generateHdcdWav(spec));
    return filePath;
}

function encodeSample(value: number, bitDepth: 16 | 24 | 32, amplitude = 0.5): Buffer {
    if (bitDepth === 16) {
        const scaled = Math.round(value * amplitude * 32767);
        const buf = Buffer.alloc(2);
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), 0);
        return buf;
    }
    if (bitDepth === 24) {
        const clamped = Math.max(
            -8388608,
            Math.min(8388607, Math.round(value * amplitude * 8388607)),
        );
        const buf = Buffer.alloc(3);
        buf[0] = clamped & 0xff;
        buf[1] = (clamped >> 8) & 0xff;
        buf[2] = (clamped >> 16) & 0xff;
        return buf;
    }
    const scaled = Math.round(value * amplitude * 2147483647);
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, scaled)), 0);
    return buf;
}

function hdcdPacketBits(): number[] {
    const window = hdcdSyncWindow();
    const code = hdcdPeakExtendCode(window);
    const bits: number[] = [];
    for (let bit = 31; bit >= 0; bit--) {
        bits.push(Number((window >> BigInt(bit)) & 1n));
    }
    for (let bit = 7; bit >= 0; bit--) {
        bits.push((code >> bit) & 1);
    }
    return bits;
}

/** 8 code bits that select control word 0x10: peak extend on, target gain 0 dB. */
function hdcdPeakExtendCode(window: bigint): number {
    for (let code = 0; code < 256; code++) {
        const next = (window << 8n) | BigInt(code);
        const transformed = (next ^ (next >> 5n) ^ (next >> 23n)) & HDCD_WINDOW_MASK;
        if ((transformed & 0x0fa00500n) !== 0x0fa00500n) {
            continue;
        }
        if ((transformed & 0xc8n) !== 0n) {
            continue;
        }
        const control = Number((transformed & 0xffn) + (transformed & 0x7n));
        if (control === 0x10) {
            return code;
        }
    }
    throw new Error('no HDCD control code produces peak-extend with 0 dB gain');
}

/** Invert the filter's `w ^ w>>5 ^ w>>23` transform for the A sync pattern. */
function hdcdSyncWindow(): bigint {
    let window = 0n;
    for (let bit = 31; bit >= 0; bit--) {
        const target = (HDCD_SYNC_A >> BigInt(bit)) & 1n;
        const fromShift5 = bit + 5 < 32 ? (window >> BigInt(bit + 5)) & 1n : 0n;
        const fromShift23 = bit + 23 < 32 ? (window >> BigInt(bit + 23)) & 1n : 0n;
        window |= (target ^ fromShift5 ^ fromShift23) << BigInt(bit);
    }
    return window;
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

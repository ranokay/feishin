import { describe, expect, it } from 'vitest';

import {
    evaluateServerRoute,
    redactStreamUrl,
    resolveRadioQueueRestore,
} from '../src/shared/signalpath/server-route';

const FLAC_SOURCE = {
    bitDepth: 16,
    channels: 2,
    container: 'flac',
    sampleRate: 44100,
    sizeBytes: 30_000_000,
};

// A stock Navidrome raw response: exact length, range support, matching mime.
const RAW_HEADERS = {
    acceptRanges: 'bytes',
    contentLength: FLAC_SOURCE.sizeBytes,
    contentType: 'audio/flac',
};

// Navidrome/TagLib declare the DSD carrier rate (DSD64 = 2822400 Hz) while
// mpv's demuxer exposes the x8 PCM rate dsd2pcm decodes to (352800 Hz).
const DSD_SOURCE = {
    bitDepth: 1,
    channels: 2,
    container: 'dsf',
    sampleRate: 2_822_400,
    sizeBytes: 360_540,
};

const DSD_DEMUXER = {
    channels: 2,
    codec: 'dsd_lsbf_planar',
    samplerate: 352_800,
};

describe('evaluateServerRoute', () => {
    it('verifies a raw stream as direct-stream with confirmed size-match evidence', () => {
        const result = evaluateServerRoute({ headers: RAW_HEADERS, source: FLAC_SOURCE });

        expect(result.route).toBe('direct-stream');
        expect(result.verification).toBe('size-match');
        expect(result.level).toBe('confirmed');
        expect(result.detail).toBeNull();
    });

    it('detects a forced server transcode via target mime and missing length', () => {
        const result = evaluateServerRoute({
            headers: { acceptRanges: null, contentLength: null, contentType: 'audio/mpeg' },
            source: FLAC_SOURCE,
        });

        expect(result.route).toBe('transcoded');
        expect(result.level).toBe('confirmed');
        expect(result.detail).toContain('audio/mpeg');
    });

    it('detects a chunked transcode when no size comparison is possible', () => {
        const result = evaluateServerRoute({
            headers: { acceptRanges: null, contentLength: null, contentType: null },
            source: FLAC_SOURCE,
        });

        expect(result.route).toBe('transcoded');
        expect(result.detail).toContain('content-length');
    });

    it('flags a content-length that differs from the declared song size', () => {
        const result = evaluateServerRoute({
            headers: { ...RAW_HEADERS, contentLength: FLAC_SOURCE.sizeBytes - 500 },
            source: FLAC_SOURCE,
        });

        expect(result.route).toBe('transcoded');
        expect(result.level).toBe('confirmed');
    });

    it('catches a cached transcode that mimics raw headers via the demuxer codec', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'opus', samplerate: 44100 },
            headers: RAW_HEADERS,
            source: FLAC_SOURCE,
        });

        expect(result.route).toBe('transcoded');
        expect(result.detail).toContain('opus');
    });

    it('catches a server-side rate change via the demuxer samplerate', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'flac', samplerate: 48000 },
            headers: RAW_HEADERS,
            source: FLAC_SOURCE,
        });

        expect(result.route).toBe('transcoded');
        expect(result.detail).toContain('48000');
    });

    it('accepts a DSD direct stream whose demuxer reports the x8 PCM rate', () => {
        const result = evaluateServerRoute({
            demuxer: DSD_DEMUXER,
            headers: {
                acceptRanges: 'bytes',
                contentLength: DSD_SOURCE.sizeBytes,
                contentType: 'audio/x-dsf',
            },
            source: DSD_SOURCE,
        });

        expect(result.route).toBe('direct-stream');
        expect(result.verification).toBe('size-match');
        expect(result.detail).toBeNull();
    });

    it('accepts a DSD stream when the server declares the x8 PCM rate instead of the carrier', () => {
        const result = evaluateServerRoute({
            demuxer: DSD_DEMUXER,
            source: { ...DSD_SOURCE, sampleRate: 352_800 },
        });

        expect(result.route).toBe('direct-stream');
        expect(result.detail).toBeNull();
    });

    it('accepts a DSD codec alias on a .dff container', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'dsd_msbf', samplerate: 352_800 },
            source: { ...DSD_SOURCE, container: 'dff' },
        });

        expect(result.route).toBe('direct-stream');
    });

    it('normalizes a mime-style x-dsf container for DSD codec and rate checks', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'dsd_lsbf_planar', samplerate: 352_800 },
            source: { ...DSD_SOURCE, container: 'x-dsf' },
        });

        expect(result.route).toBe('direct-stream');
        expect(result.detail).toBeNull();
    });

    it('still flags a DSD stream whose rate is neither the carrier nor its x8 PCM rate', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'dsd_lsbf_planar', samplerate: 44_100 },
            source: DSD_SOURCE,
        });

        expect(result.route).toBe('transcoded');
        expect(result.detail).toContain('44100');
    });

    it('still flags a non-DSD codec on a DSD container', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'flac', samplerate: 352_800 },
            source: DSD_SOURCE,
        });

        expect(result.route).toBe('transcoded');
        expect(result.detail).toContain('flac');
    });

    it('degrades to unknown when nothing could be observed', () => {
        const result = evaluateServerRoute({ source: FLAC_SOURCE });

        expect(result.route).toBe('unverified');
        expect(result.verification).toBe('unverified');
        expect(result.level).toBe('unknown');
        expect(result.detail).toBeNull();
    });

    it('never claims verified when only consistent-but-incomparable headers exist', () => {
        const result = evaluateServerRoute({
            headers: { acceptRanges: 'bytes', contentLength: null, contentType: 'audio/flac' },
            source: { ...FLAC_SOURCE, sizeBytes: null },
        });

        expect(result.route).toBe('direct-stream');
        expect(result.verification).toBe('header-match');
        expect(result.level).toBe('inferred');
    });

    it('verifies from demuxer agreement alone at inferred tier when headers are unprovable', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'flac', samplerate: 44100 },
            source: FLAC_SOURCE,
        });

        expect(result.route).toBe('direct-stream');
        expect(result.verification).toBe('metadata-match');
        expect(result.level).toBe('inferred');
    });

    it('stays unverified when headers carry nothing comparable to the declaration', () => {
        const result = evaluateServerRoute({
            headers: RAW_HEADERS,
            source: { ...FLAC_SOURCE, container: null, sizeBytes: null },
        });

        expect(result.route).toBe('unverified');
        expect(result.level).toBe('unknown');
    });

    it('lets a contradiction win over a positive size match', () => {
        const result = evaluateServerRoute({
            demuxer: { channels: 2, codec: 'aac', samplerate: 44100 },
            headers: RAW_HEADERS,
            source: FLAC_SOURCE,
        });

        expect(result.route).toBe('transcoded');
    });

    it('accepts known container aliases for mime and codec checks', () => {
        const m4a = { ...FLAC_SOURCE, container: 'm4a' };
        expect(
            evaluateServerRoute({
                headers: { ...RAW_HEADERS, contentType: 'audio/mp4' },
                source: m4a,
            }).route,
        ).toBe('direct-stream');

        const wav = { ...FLAC_SOURCE, container: 'wav' };
        expect(
            evaluateServerRoute({
                demuxer: { channels: 2, codec: 'pcm_s16le', samplerate: 44100 },
                source: wav,
            }).route,
        ).toBe('direct-stream');

        const ogg = { ...FLAC_SOURCE, container: 'ogg' };
        expect(
            evaluateServerRoute({
                demuxer: { channels: 2, codec: 'opus', samplerate: 44100 },
                source: ogg,
            }).route,
        ).toBe('direct-stream');
    });

    it('verifies lossy sources by route without judging their codec quality', () => {
        const result = evaluateServerRoute({
            headers: { ...RAW_HEADERS, contentType: 'audio/mpeg' },
            source: { ...FLAC_SOURCE, container: 'mp3' },
        });

        expect(result.route).toBe('direct-stream');
        expect(result.verification).toBe('size-match');
    });

    it('ignores an absent Accept-Ranges header as a standalone signal', () => {
        const result = evaluateServerRoute({
            headers: {
                acceptRanges: null,
                contentLength: FLAC_SOURCE.sizeBytes,
                contentType: null,
            },
            source: { ...FLAC_SOURCE, container: null },
        });

        // Size still matches exactly; ranges alone must not flip to transcoded.
        expect(result.route).toBe('direct-stream');
        expect(result.verification).toBe('size-match');
    });
});

describe('resolveRadioQueueRestore', () => {
    it('returns nothing when no station is active', () => {
        expect(
            resolveRadioQueueRestore({
                currentStreamUrl: null,
                isPlaying: true,
                playbackKey: 'radio-1',
            }),
        ).toBeNull();
    });

    it('returns nothing until the station has a playback key', () => {
        expect(
            resolveRadioQueueRestore({
                currentStreamUrl: 'https://radio/stream',
                isPlaying: true,
                playbackKey: null,
            }),
        ).toBeNull();
    });

    it('restores the station tagged as radio and resumes a playing station', () => {
        expect(
            resolveRadioQueueRestore({
                currentStreamUrl: 'https://radio/stream',
                isPlaying: true,
                playbackKey: 'radio-1',
            }),
        ).toEqual({
            pause: false,
            stream: { kind: 'radio', playbackKey: 'radio-1', url: 'https://radio/stream' },
        });
    });

    it('restores a paused station without resuming it', () => {
        expect(
            resolveRadioQueueRestore({
                currentStreamUrl: 'https://radio/stream',
                isPlaying: false,
                playbackKey: 'radio-1',
            }),
        ).toEqual({
            pause: true,
            stream: { kind: 'radio', playbackKey: 'radio-1', url: 'https://radio/stream' },
        });
    });
});

describe('redactStreamUrl', () => {
    it('scrubs query credentials while keeping safe diagnostic shape', () => {
        expect(
            redactStreamUrl('https://navi.example/rest/stream.view?id=abc&v=1.13.0&t=tok&s=salt'),
        ).toBe('https://navi.example/rest/stream.view?id=abc&v=1.13.0&t=<redacted>&s=<redacted>');
    });

    it('strips http userinfo from the authority', () => {
        expect(redactStreamUrl('https://user:password@host/rest/stream?id=abc&maxBitRate=0')).toBe(
            'https://<redacted>@host/rest/stream?id=abc&maxBitRate=0',
        );
    });

    it('redacts userinfo even without a query string', () => {
        expect(redactStreamUrl('https://user:password@host/rest/stream')).toBe(
            'https://<redacted>@host/rest/stream',
        );
    });
});

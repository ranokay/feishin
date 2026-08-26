import { describe, expect, it } from 'vitest';

import { evaluateServerRoute, redactStreamUrl } from '../src/shared/signalpath/server-route';

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

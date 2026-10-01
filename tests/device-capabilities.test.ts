import { describe, expect, it } from 'vitest';

import {
    assembleDeviceCapabilities,
    type DeviceCapabilityInput,
    parseCoreAudioFormatLine,
} from '../src/shared/signalpath/device-capabilities';

// Real v-level lines from mpv's ao_coreaudio_exclusive / ca_print_asbd
// (verbatim grammar verified against mpv v0.38.0 - v0.41.0 sources).
const AVAILABLE_44100 =
    '-   44100.0Hz 32bit lpcm [9][4bpp][1fbp][4bpf][2ch] float LE U packed (float)';
const ACTIVE_LINE =
    'actual format in use:  96000.0Hz 32bit lpcm [9][4bpp][1fbp][4bpf][2ch] float LE U packed (float)';

const baseInput: DeviceCapabilityInput = {
    availablePhysicalFormats: null,
    deviceDescription: 'BuiltInSpeakerDevice',
    deviceId: 'coreaudio/BuiltInSpeakerDevice',
    observedDeviceId: 'coreaudio/BuiltInSpeakerDevice',
    outputParams: { channels: 2, format: 'float', samplerate: 96000 },
    physicalFormat: {
        level: 'inferred',
        source: 'mpv-log',
        value: '96000 Hz / 32-bit / 2ch / float',
    },
    platform: 'darwin',
    requestedExclusive: true,
    route: 'coreaudio_exclusive',
};

describe('parseCoreAudioFormatLine', () => {
    it('classifies the available-format list lines as inferred-tier table rows', () => {
        expect(parseCoreAudioFormatLine(AVAILABLE_44100)).toEqual({
            bitsPerChannel: 32,
            channels: 2,
            format: 'float',
            formatId: 'lpcm',
            label: '44100 Hz / 32-bit / 2ch / float',
            mpFormat: 'float',
            role: 'available',
            sampleRate: 44100,
        });
    });

    it('classifies the negotiation lines around the physical format change', () => {
        expect(parseCoreAudioFormatLine('our format:  48000.0Hz 32bit lpcm')?.role).toBe(
            'our-format',
        );
        expect(
            parseCoreAudioFormatLine(
                'setting stream physical format:  96000.0Hz 32bit lpcm [9][4bpp][1fbp][4bpf][2ch] float LE U packed (float)',
            )?.role,
        ).toBe('requested');
        expect(
            parseCoreAudioFormatLine(
                'format in use before switching:  44100.0Hz 32bit lpcm [9][4bpp][1fbp][4bpf][2ch] float LE U packed (float)',
            )?.role,
        ).toBe('previous');
        expect(parseCoreAudioFormatLine(ACTIVE_LINE)?.role).toBe('active');
        expect(
            parseCoreAudioFormatLine(
                'virtual format  96000.0Hz 32bit lpcm [9][4bpp][1fbp][4bpf][2ch] float LE U packed (float)',
            )?.role,
        ).toBe('virtual');
    });

    it('parses integer physical formats without inventing a float tag', () => {
        const parsed = parseCoreAudioFormatLine(
            '-   176400.0Hz 24bit lpcm [11][3bpp][1fbp][6bpf][2ch] int LE S packed (s24)',
        );

        expect(parsed).toEqual({
            bitsPerChannel: 24,
            channels: 2,
            format: 's24',
            formatId: 'lpcm',
            label: '176400 Hz / 24-bit / 2ch / s24',
            mpFormat: 's24',
            role: 'available',
            sampleRate: 176400,
        });
    });

    it('falls back to the ASBD tag when no mpv format name is printed', () => {
        expect(
            parseCoreAudioFormatLine(
                '-   48000.0Hz 16bit lpcm [1][2bpp][1fbp][4bpf][2ch] int LE S packed (-)',
            )?.label,
        ).toBe('48000 Hz / 16-bit / 2ch / lpcm');
    });

    it('ignores lines that are not ASBD dumps', () => {
        expect(parseCoreAudioFormatLine('changing physical format failed')).toBeNull();
        expect(
            parseCoreAudioFormatLine('Selected physical format: 96000 Hz float32 2ch'),
        ).toBeNull();
        expect(parseCoreAudioFormatLine('-   44100.0Hz not-a-format')).toBeNull();
    });
});

describe('assembleDeviceCapabilities', () => {
    it('reports confirmed device, route, and output for a running exclusive session', () => {
        const entries = assembleDeviceCapabilities(baseInput);
        const byField = Object.fromEntries(entries.map((entry) => [entry.field, entry]));

        expect(byField['device']).toMatchObject({
            level: 'confirmed',
            reason: null,
            value: 'coreaudio/BuiltInSpeakerDevice - BuiltInSpeakerDevice',
        });
        expect(byField['route']).toMatchObject({
            level: 'confirmed',
            value: 'coreaudio_exclusive',
        });
        expect(byField['output']).toMatchObject({
            level: 'confirmed',
            value: 'float / 96000 Hz / 2ch',
        });
    });

    it('reports the macOS log-derived format table as inferred, with the active row', () => {
        const entries = assembleDeviceCapabilities({
            ...baseInput,
            availablePhysicalFormats: [
                {
                    channels: 2,
                    format: 'float',
                    label: '44100 Hz / 32-bit / 2ch / float',
                    sampleRate: 44100,
                },
                {
                    channels: 2,
                    format: 'float',
                    label: '96000 Hz / 32-bit / 2ch / float',
                    sampleRate: 96000,
                },
            ],
        });
        const row = entries.find((entry) => entry.field === 'physicalFormats');

        expect(row?.level).toBe('inferred');
        expect(row?.reason).toBeNull();
        expect(row?.formats?.map((format) => format.sampleRate)).toEqual([44100, 96000]);
        expect(row?.activeFormat?.sampleRate).toBe(96000);
    });

    it('marks non-derivable fields unknown with a reason on every platform', () => {
        const pending = assembleDeviceCapabilities(baseInput);
        expect(pending.find((entry) => entry.field === 'physicalFormats')).toMatchObject({
            level: 'unknown',
            reason: 'exclusive-session-pending',
            value: null,
        });

        const darwin = assembleDeviceCapabilities({
            ...baseInput,
            requestedExclusive: false,
            route: 'coreaudio',
        });
        expect(darwin.find((entry) => entry.field === 'physicalFormats')).toMatchObject({
            level: 'unknown',
            reason: 'exclusive-session-required',
            value: null,
        });

        for (const platform of ['linux', 'win32'] as const) {
            const entries = assembleDeviceCapabilities({ ...baseInput, platform });
            const row = entries.find((entry) => entry.field === 'physicalFormats');

            expect(row).toMatchObject({ level: 'unknown', reason: 'platform-unavailable' });
        }

        expect(darwin.find((entry) => entry.field === 'dsd')).toMatchObject({
            level: 'unknown',
            reason: 'dsd-unsupported',
        });
        expect(darwin.find((entry) => entry.field === 'hardwareVolume')).toMatchObject({
            level: 'unknown',
            reason: 'hardware-volume-unavailable',
        });
    });

    it('hides active-session facts when mpv has a different device configured', () => {
        const entries = assembleDeviceCapabilities({
            ...baseInput,
            availablePhysicalFormats: [
                {
                    channels: 2,
                    format: 'float',
                    label: '96000 Hz / 32-bit / 2ch / float',
                    sampleRate: 96000,
                },
            ],
            observedDeviceId: 'coreaudio/USBDAC',
        });
        const byField = Object.fromEntries(entries.map((entry) => [entry.field, entry]));

        expect(byField['device']).toMatchObject({ level: 'requested', reason: null });
        expect(byField['route']).toMatchObject({
            level: 'unknown',
            reason: 'device-not-active',
            value: null,
        });
        expect(byField['output']).toMatchObject({
            level: 'unknown',
            reason: 'device-not-active',
            value: null,
        });
        expect(byField['physicalFormats']).toMatchObject({
            level: 'unknown',
            reason: 'device-not-active',
        });
    });

    it('marks an exclusive request unconfirmed until mpv reports the driver', () => {
        const entries = assembleDeviceCapabilities({
            ...baseInput,
            route: null,
        });
        const route = entries.find((entry) => entry.field === 'route');

        expect(route).toMatchObject({
            detail: 'exclusive-requested',
            level: 'requested',
            reason: null,
            value: null,
        });
    });

    it('keeps the output row honest when mpv reports partial params', () => {
        const partial = assembleDeviceCapabilities({
            ...baseInput,
            outputParams: { channels: null, format: null, samplerate: 44100 },
        });
        expect(partial.find((entry) => entry.field === 'output')).toMatchObject({
            level: 'confirmed',
            value: '44100 Hz',
        });

        const empty = assembleDeviceCapabilities({
            ...baseInput,
            outputParams: { channels: null, format: null, samplerate: null },
        });
        expect(empty.find((entry) => entry.field === 'output')).toMatchObject({
            level: 'unknown',
            reason: 'no-session',
            value: null,
        });
    });

    it('reports route and output unknown when no mpv session has been observed', () => {
        const entries = assembleDeviceCapabilities({
            availablePhysicalFormats: null,
            deviceDescription: null,
            deviceId: 'auto',
            observedDeviceId: null,
            outputParams: null,
            physicalFormat: null,
            platform: 'darwin',
            requestedExclusive: false,
            route: null,
        });
        const byField = Object.fromEntries(entries.map((entry) => [entry.field, entry]));

        expect(byField['route']).toMatchObject({ level: 'unknown', reason: 'no-session' });
        expect(byField['output']).toMatchObject({ level: 'unknown', reason: 'no-session' });
    });
});

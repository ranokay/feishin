import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    type DeviceProfileMap,
    normalizeDeviceProfiles,
    normalizePlaybackPolicy,
    normalizePlaybackPolicySelection,
    normalizeSourceDecodeOptions,
    PLAYBACK_POLICIES,
    PLAYBACK_POLICY_SELECTIONS,
    type PlaybackPolicy,
    type PlaybackPolicySelection,
    type SourceDecodeOptions,
} from '../src/shared/signalpath';

const PlaybackPolicySchema = z.object({
    playbackPolicy: z.enum([...PLAYBACK_POLICY_SELECTIONS]),
});

// Mirrors the store migration block for persisted settings version < 34.
const migratePlaybackPolicy = (persisted: {
    playback?: { playbackPolicy?: unknown };
}): { playback: { playbackPolicy: PlaybackPolicy } } => ({
    playback: {
        playbackPolicy: normalizePlaybackPolicy(persisted.playback?.playbackPolicy),
    },
});

// Mirrors the store migration block for persisted settings version < 36.
const migrateDeviceProfiles = (persisted: {
    playback?: { deviceProfiles?: unknown };
}): { playback: { deviceProfiles: DeviceProfileMap } } => ({
    playback: {
        deviceProfiles: normalizeDeviceProfiles(persisted.playback?.deviceProfiles),
    },
});

// Mirrors the store migration block for persisted settings version < 38.
const migrateSourceDecode = (persisted: {
    playback?: { sourceDecode?: unknown };
}): { playback: { sourceDecode: SourceDecodeOptions } } => ({
    playback: {
        sourceDecode: normalizeSourceDecodeOptions(persisted.playback?.sourceDecode),
    },
});

describe('normalizePlaybackPolicy', () => {
    it.each(PLAYBACK_POLICIES)('passes through the valid policy %s', (policy) => {
        expect(normalizePlaybackPolicy(policy)).toBe(policy);
    });

    it.each([undefined, null, 42, {}, 'hifi', 'bitperfect', 'BIT-PERFECT'])(
        'coerces invalid value %s to standard',
        (value) => {
            expect(normalizePlaybackPolicy(value)).toBe('standard');
        },
    );
});

describe('normalizePlaybackPolicySelection', () => {
    it.each(PLAYBACK_POLICY_SELECTIONS)('passes through the valid selection %s', (selection) => {
        expect(normalizePlaybackPolicySelection(selection)).toBe(selection);
    });

    it.each([undefined, null, 42, {}, 'hifi', 'auto-mode', 'AUTO'])(
        'coerces invalid selection %s to standard',
        (value) => {
            expect(normalizePlaybackPolicySelection(value)).toBe('standard');
        },
    );
});

describe('playback policy settings schema parsing', () => {
    it('accepts every declared policy selection', () => {
        for (const selection of PLAYBACK_POLICY_SELECTIONS) {
            const result = PlaybackPolicySchema.safeParse({ playbackPolicy: selection });
            expect(result.success).toBe(true);
        }
    });

    it('rejects undeclared presets instead of silently coercing them on import', () => {
        const result = PlaybackPolicySchema.safeParse({ playbackPolicy: 'ultra' });
        expect(result.success).toBe(false);
    });
});

// Mirrors the store migration block for persisted settings version < 39.
const migratePlaybackPolicySelection = (persisted: {
    playback?: { playbackPolicy?: unknown };
}): { playback: { playbackPolicy: PlaybackPolicySelection } } => ({
    playback: {
        playbackPolicy: normalizePlaybackPolicySelection(persisted.playback?.playbackPolicy),
    },
});

describe('persisted playback policy selection migration', () => {
    it('preserves the auto selection across migration', () => {
        expect(
            migratePlaybackPolicySelection({ playback: { playbackPolicy: 'auto' } }).playback
                .playbackPolicy,
        ).toBe('auto');
    });

    it('resets corrupted persisted selections back to standard', () => {
        expect(
            migratePlaybackPolicySelection({ playback: { playbackPolicy: 'hifi' } }).playback
                .playbackPolicy,
        ).toBe('standard');
    });

    it('tolerates missing playback sections', () => {
        expect(migratePlaybackPolicySelection({}).playback.playbackPolicy).toBe('standard');
    });
});

describe('persisted playback policy migration', () => {
    it('fills the default losslessly for installs that predate the setting', () => {
        const migrated = migratePlaybackPolicy({
            playback: { playbackPolicy: undefined },
        });

        expect(migrated.playback.playbackPolicy).toBe('standard');
    });

    it('preserves a chosen strict preset across migration', () => {
        const migrated = migratePlaybackPolicy({ playback: { playbackPolicy: 'bit-perfect' } });

        expect(migrated.playback.playbackPolicy).toBe('bit-perfect');
    });

    it('resets corrupted persisted values back to standard', () => {
        const migrated = migratePlaybackPolicy({ playback: { playbackPolicy: 'hifi' } });

        expect(migrated.playback.playbackPolicy).toBe('standard');
    });

    it('tolerates missing playback sections', () => {
        expect(migratePlaybackPolicy({}).playback.playbackPolicy).toBe('standard');
    });
});

describe('persisted device profile migration', () => {
    it('fills an empty map for installs that predate the setting', () => {
        expect(migrateDeviceProfiles({}).playback.deviceProfiles).toEqual({});
    });

    it('preserves saved profiles across migration', () => {
        const migrated = migrateDeviceProfiles({
            playback: {
                deviceProfiles: {
                    'usb-dac': { description: 'USB DAC', policyOverride: 'bit-perfect' },
                },
            },
        });

        expect(migrated.playback.deviceProfiles).toEqual({
            'usb-dac': { description: 'USB DAC', policyOverride: 'bit-perfect' },
        });
    });

    it('drops corrupted entries and keeps the valid ones', () => {
        const migrated = migrateDeviceProfiles({
            playback: {
                deviceProfiles: {
                    'usb-dac': { description: 'USB DAC', policyOverride: 'bit-perfect' },
                    'wasapi/{guid}': { policyOverride: 'loud' },
                },
            },
        });

        expect(migrated.playback.deviceProfiles).toEqual({
            'usb-dac': { description: 'USB DAC', policyOverride: 'bit-perfect' },
        });
    });
});

describe('persisted source decode migration', () => {
    it('defaults both decodes to off for installs that predate the setting', () => {
        expect(migrateSourceDecode({}).playback.sourceDecode).toEqual({
            deEmphasis: false,
            hdcd: false,
        });
    });

    it('preserves an explicit opt-in across migration', () => {
        expect(
            migrateSourceDecode({ playback: { sourceDecode: { hdcd: true } } }).playback
                .sourceDecode,
        ).toEqual({ deEmphasis: false, hdcd: true });
    });

    it('resets corrupted values to off instead of trusting them', () => {
        expect(
            migrateSourceDecode({ playback: { sourceDecode: { deEmphasis: 'yes', hdcd: 1 } } })
                .playback.sourceDecode,
        ).toEqual({ deEmphasis: false, hdcd: false });
    });
});

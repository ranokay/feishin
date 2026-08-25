import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    normalizePlaybackPolicy,
    PLAYBACK_POLICIES,
    type PlaybackPolicy,
} from '../src/shared/signalpath';

const PlaybackPolicySchema = z.object({
    playbackPolicy: z.enum([...PLAYBACK_POLICIES]),
});

// Mirrors the store migration block for persisted settings version < 34.
const migratePlaybackPolicy = (persisted: {
    playback?: { playbackPolicy?: unknown };
}): { playback: { playbackPolicy: PlaybackPolicy } } => ({
    playback: {
        playbackPolicy: normalizePlaybackPolicy(persisted.playback?.playbackPolicy),
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

describe('playback policy settings schema parsing', () => {
    it('accepts every declared policy preset', () => {
        for (const policy of PLAYBACK_POLICIES) {
            const result = PlaybackPolicySchema.safeParse({ playbackPolicy: policy });
            expect(result.success).toBe(true);
        }
    });

    it('rejects undeclared presets instead of silently coercing them on import', () => {
        const result = PlaybackPolicySchema.safeParse({ playbackPolicy: 'ultra' });
        expect(result.success).toBe(false);
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

import { BIT_PERFECT_PROPERTY_PINS, strictPropertyRecord } from './strict-properties';

export const PLAYBACK_POLICIES = ['standard', 'exclusive', 'bit-perfect'] as const;

export type Platform = 'darwin' | 'linux' | 'win32';

export type PlaybackPolicy = (typeof PLAYBACK_POLICIES)[number];

export function normalizePlaybackPolicy(value: unknown): PlaybackPolicy {
    return PLAYBACK_POLICIES.includes(value as PlaybackPolicy)
        ? (value as PlaybackPolicy)
        : 'standard';
}

const PLATFORM_AO_PIN: Partial<Record<Platform, string>> = {
    darwin: 'coreaudio',
    win32: 'wasapi',
};

export interface EffectivePlaybackConfig {
    conflicts: PolicyConflict[];
    requestedExclusive: boolean;
    runtimeProperties: Record<string, unknown>;
    startupArgs: string[];
}

export interface PolicyConflict {
    effect: 'blocked-under-policy' | 'disabled-under-policy';
    feature: string;
}

export interface PolicyInputs {
    audioFadeEnabled: boolean;
    compressorEnabled: boolean;
    equalizerEnabled: boolean;
    forcedSampleRateHz: null | number;
    platform: Platform;
    policy: PlaybackPolicy;
    replayGainMode: ReplayGainMode;
    speed: number;
}

export interface PolicyStartupConfig {
    runtimeProperties: Record<string, unknown>;
    startupArgs: string[];
}

export type ReplayGainMode = 'album' | 'no' | 'track';

/**
 * Startup-only mpv configuration a policy demands (AO pinning, exclusive
 * flags, strict pins). Standard returns empty so the existing arg/property
 * set stays byte-identical.
 */
export function policyStartupConfig(
    policy: PlaybackPolicy,
    platform: Platform,
): PolicyStartupConfig {
    if (policy === 'standard') {
        return { runtimeProperties: {}, startupArgs: [] };
    }
    const aoPin = PLATFORM_AO_PIN[platform];
    const startupArgs = [...(aoPin ? [`--ao=${aoPin}`] : []), '--audio-exclusive=yes'];
    const runtimeProperties: Record<string, unknown> = { 'audio-exclusive': 'yes' };
    if (policy === 'bit-perfect') {
        startupArgs.push('--gapless-audio=weak');
        Object.assign(runtimeProperties, strictPropertyRecord(BIT_PERFECT_PROPERTY_PINS));
    }
    return { runtimeProperties, startupArgs };
}

export function resolvePolicy(inputs: PolicyInputs): EffectivePlaybackConfig {
    switch (inputs.policy) {
        case 'bit-perfect':
            return resolveBitPerfect(inputs);
        case 'exclusive':
            return resolveExclusive(inputs);
        default:
            return {
                conflicts: [],
                requestedExclusive: false,
                runtimeProperties: {},
                startupArgs: [],
            };
    }
}

function collectStrictConflicts(inputs: PolicyInputs): PolicyConflict[] {
    const conflicts: PolicyConflict[] = [];
    if (inputs.equalizerEnabled || inputs.compressorEnabled) {
        conflicts.push({ effect: 'disabled-under-policy', feature: 'dsp' });
    }
    if (inputs.replayGainMode !== 'no') {
        conflicts.push({ effect: 'disabled-under-policy', feature: 'replaygain' });
    }
    if (inputs.audioFadeEnabled) {
        conflicts.push({ effect: 'disabled-under-policy', feature: 'fades' });
    }
    if (inputs.forcedSampleRateHz !== null && inputs.forcedSampleRateHz > 0) {
        conflicts.push({ effect: 'blocked-under-policy', feature: 'forced-sample-rate' });
    }
    if (inputs.speed !== 1) {
        conflicts.push({ effect: 'disabled-under-policy', feature: 'speed' });
    }
    return conflicts;
}

function resolveBitPerfect(inputs: PolicyInputs): EffectivePlaybackConfig {
    const conflicts = collectStrictConflicts(inputs);
    const base = policyStartupConfig('bit-perfect', inputs.platform);
    return {
        conflicts,
        requestedExclusive: true,
        runtimeProperties: base.runtimeProperties,
        startupArgs: base.startupArgs,
    };
}

function resolveExclusive(inputs: PolicyInputs): EffectivePlaybackConfig {
    const base = policyStartupConfig('exclusive', inputs.platform);
    return {
        conflicts: [],
        requestedExclusive: true,
        runtimeProperties: base.runtimeProperties,
        startupArgs: base.startupArgs,
    };
}

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

export type ReplayGainMode = 'album' | 'no' | 'track';

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
    const runtimeProperties: Record<string, unknown> = {
        'audio-exclusive': 'yes',
        'gapless-audio': 'weak',
        mute: false,
        replaygain: 'no',
        speed: 1,
        volume: 100,
    };
    const startupArgs = ['--audio-exclusive=yes', '--gapless-audio=weak'];
    const aoPin = PLATFORM_AO_PIN[inputs.platform];
    if (aoPin) {
        startupArgs.unshift(`--ao=${aoPin}`);
    }
    return { conflicts, requestedExclusive: true, runtimeProperties, startupArgs };
}

function resolveExclusive(inputs: PolicyInputs): EffectivePlaybackConfig {
    const aoPin = PLATFORM_AO_PIN[inputs.platform];
    return {
        conflicts: [],
        requestedExclusive: true,
        runtimeProperties: { 'audio-exclusive': 'yes' },
        startupArgs: [...(aoPin ? [`--ao=${aoPin}`] : []), '--audio-exclusive=yes'],
    };
}

import type { Platform, PlaybackPolicy } from './policy';

import { filterPolicyExtraParameters, policyStartupConfig } from './policy';

export interface MpvEngineConfig {
    extraParameters: string[];
    properties: Record<string, unknown>;
}

export interface MpvEngineConfigInputs {
    deviceId: null | string | undefined;
    extraParameters: readonly string[];
    mpvProperties: Record<string, unknown>;
    mute: boolean | undefined;
    platform: Platform;
    playbackPolicy: PlaybackPolicy;
    preservePitch: boolean | undefined;
    speed: number | undefined;
    volume: number;
}

/**
 * Single source of truth for the mpv startup property and argument composition.
 * It lives in shared so tests can prove strict pins override user properties and
 * policy arguments are appended after user arguments without importing the
 * renderer engine.
 */
export function buildMpvEngineConfig(inputs: MpvEngineConfigInputs): MpvEngineConfig {
    const { runtimeProperties, startupArgs } = policyStartupConfig(
        inputs.playbackPolicy,
        inputs.platform,
    );

    // Policy-derived runtime pins go last so strict values (unity gain, unit
    // speed) win over both user mpv properties and control defaults.
    const properties: Record<string, unknown> = {
        ...inputs.mpvProperties,
        'audio-pitch-correction': inputs.preservePitch === false ? 'no' : 'yes',
        mute: inputs.mute,
        speed: inputs.speed,
        volume: inputs.volume,
        ...runtimeProperties,
    };

    const extraParameters = [
        ...filterPolicyExtraParameters(inputs.playbackPolicy, inputs.extraParameters),
        ...startupArgs,
    ];
    extraParameters.push(`--audio-device=${inputs.deviceId?.trim() || 'auto'}`);

    return { extraParameters, properties };
}

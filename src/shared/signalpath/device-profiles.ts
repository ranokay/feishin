import { type ConfidenceLevel } from './evidence';
import {
    normalizePlaybackPolicy,
    type PlaybackPolicy,
    type PlaybackPolicySelection,
} from './policy';

export interface AutoDevicePolicyDecision {
    level: ConfidenceLevel;
    policy: PlaybackPolicy;
    reason: AutoDevicePolicyReason;
}

export type AutoDevicePolicyReason =
    | 'built-in-device'
    | 'external-device'
    | 'no-device'
    | 'unknown-device'
    | 'virtual-device'
    | 'wireless-device';

export interface DeviceProfile {
    description: null | string;
    policyOverride: PlaybackPolicy;
}

export type DeviceProfileMap = Record<string, DeviceProfile>;

export interface EffectivePlaybackPolicyDecision {
    /** Set only when the winning selection was `auto`; carries the disclosure. */
    auto: AutoDevicePolicyDecision | null;
    policy: PlaybackPolicy;
}

export interface ResolvedDeviceProfile {
    key: string;
    profile: DeviceProfile;
}

// mpv resolves a missing or blank `audio-device` to its `auto` device, which is
// also the first entry in its device list. Profiles keyed `auto` therefore cover
// the default selection.
const MPV_DEFAULT_DEVICE_ID = 'auto';

// Assigning these keys would mutate the map's prototype instead of adding an
// entry; persisted payloads are untrusted, so drop them.
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface DeviceDescriptionEntry {
    description?: null | string;
    value: string;
}

export function normalizeDeviceDescription(value: null | string | undefined): null | string {
    const normalized = value?.trim().replace(/\s+/g, ' ').toLowerCase();
    return normalized ? normalized : null;
}

/**
 * Repairs persisted profile maps. Entries without a valid policy override are
 * dropped rather than coerced: an unreadable override carries no intent, and
 * inventing one would pin the device to a policy the user never chose. The
 * device then falls back to the global policy, like an unknown device.
 */
export function normalizeDeviceProfiles(value: unknown): DeviceProfileMap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const profiles: DeviceProfileMap = {};
    for (const [key, entry] of Object.entries(value)) {
        const deviceId = key.trim();
        if (!deviceId || PROTOTYPE_KEYS.has(deviceId)) {
            continue;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry as { description?: unknown; policyOverride?: unknown };
        const policyOverride = candidate.policyOverride;
        if (!isPlaybackPolicy(policyOverride)) {
            continue;
        }
        profiles[deviceId] = {
            description: typeof candidate.description === 'string' ? candidate.description : null,
            policyOverride,
        };
    }
    return profiles;
}

export function normalizeMpvDeviceId(deviceId: null | string | undefined): string {
    return deviceId?.trim() || MPV_DEFAULT_DEVICE_ID;
}

/**
 * The description to refresh a selected device with from an enumerated device
 * list. Returns null when there is nothing to write: no selection, the device
 * is not in the list (unplugged), the live entry has no description, or the
 * stored description already matches.
 *
 * `mpvAudioDeviceDescription` is both the profile description fallback and an
 * Auto classification input, so installs that picked a device before
 * descriptions were persisted stay stale until an enumeration refreshes it.
 */
export function resolveLiveDeviceDescription(
    devices: readonly DeviceDescriptionEntry[],
    deviceId: null | string | undefined,
    storedDescription: null | string | undefined,
): null | string {
    if (!deviceId) {
        return null;
    }
    const live = devices.find((device) => device.value === deviceId)?.description?.trim();
    if (!live || live === storedDescription) {
        return null;
    }
    return live;
}

// Device-class keyword sets for the Auto ("Best Quality") heuristic. Matching is
// case-insensitive and runs against the device id and description together.
const VIRTUAL_DEVICE_PATTERNS = [
    'aggregate',
    'blackhole',
    'loopback',
    'multi-output',
    'null',
    'soundflower',
    'vb cable',
    'vb-cable',
    'virtual',
];

const WIRELESS_DEVICE_PATTERNS = ['airplay', 'airpods', 'bluetooth', 'wi-fi', 'wifi', 'wireless'];

const BUILT_IN_DEVICE_PATTERNS = [
    'applehdaengine',
    'built in',
    'built-in',
    'builtin',
    'imac',
    'internal',
    'macbook',
    'realtek',
];

const EXTERNAL_DEVICE_PATTERNS = ['audio interface', 'usb'];

// 'dac' is all hex digits, and WASAPI device ids are opaque hex GUIDs, so a
// random endpoint id can contain it by chance. It only counts as a standalone
// label word ("USB DAC", "DAC/amp"), never as a substring of an id or of a
// longer label word.
const EXTERNAL_DAC_LABEL_PATTERN = /\bdac\b/;

/**
 * Conservative device-class heuristic behind the Auto ("Best Quality")
 * selection. It returns `exclusive` only for devices it can positively identify
 * as dedicated external audio hardware; built-in, wireless, virtual, and
 * unrecognized devices all resolve to `standard`.
 *
 * Rules, checked in order against the lowercased device id and description:
 * 1. Virtual/loopback drivers (BlackHole, Loopback, Soundflower, VB-Cable,
 *    aggregate, virtual) - standard. Exclusions win over a positive match, so a
 *    virtual device named "USB ..." stays standard.
 * 2. Wireless/streaming endpoints (Bluetooth, AirPlay, AirPods, Wi-Fi) - standard.
 * 3. External audio (USB or "audio interface" tokens in the id or description,
 *    "dac" only as a standalone label word) - exclusive. Nothing else proves
 *    external: an ALSA `hw:` id can be either a USB DAC or the built-in codec
 *    (e.g. `alsa/hw:CARD=PCH,DEV=0` is a laptop's HDA Intel), and a WASAPI GUID
 *    can contain "dac" by chance, so both stay unrecognized rather than guessing.
 * 4. Built-in host audio (AppleHDA, BuiltIn, MacBook/iMac, internal, Realtek,
 *    the built-in speaker id) - standard.
 * 5. No match, or no explicit device selected (mpv `auto`) - standard.
 *
 * `bit-perfect` is never selected: strict enforcement stays an explicit opt-in,
 * so Auto can never silently enable it. `level` is `inferred` for a keyword
 * classification and `unknown` for the conservative fallback. A keyword result
 * is only a hint - a per-device profile always overrides the whole decision.
 */
export function resolveAutoDevicePolicy(
    deviceId: null | string | undefined,
    description: null | string | undefined,
): AutoDevicePolicyDecision {
    if (normalizeMpvDeviceId(deviceId) === MPV_DEFAULT_DEVICE_ID) {
        return { level: 'unknown', policy: 'standard', reason: 'no-device' };
    }

    const label = (description ?? '').toLowerCase();
    const facts = `${deviceId ?? ''} ${label}`.toLowerCase();
    if (matchesDevicePattern(facts, VIRTUAL_DEVICE_PATTERNS)) {
        return { level: 'inferred', policy: 'standard', reason: 'virtual-device' };
    }
    if (matchesDevicePattern(facts, WIRELESS_DEVICE_PATTERNS)) {
        return { level: 'inferred', policy: 'standard', reason: 'wireless-device' };
    }
    if (
        matchesDevicePattern(facts, EXTERNAL_DEVICE_PATTERNS) ||
        EXTERNAL_DAC_LABEL_PATTERN.test(label)
    ) {
        return { level: 'inferred', policy: 'exclusive', reason: 'external-device' };
    }
    if (matchesDevicePattern(facts, BUILT_IN_DEVICE_PATTERNS)) {
        return { level: 'inferred', policy: 'standard', reason: 'built-in-device' };
    }
    return { level: 'unknown', policy: 'standard', reason: 'unknown-device' };
}

/**
 * Resolves the profile for a device: exact mpv id first, then a unique
 * normalized-description match for replug stability. Ambiguous descriptions
 * resolve to null so a shared name never silently applies the wrong policy.
 * A missing map (corrupt persisted state) resolves to no profile.
 */
export function resolveDeviceProfile(
    profiles: DeviceProfileMap | null | undefined,
    deviceId: null | string | undefined,
    description: null | string | undefined,
): null | ResolvedDeviceProfile {
    if (!profiles) {
        return null;
    }

    const deviceKey = normalizeMpvDeviceId(deviceId);
    if (Object.hasOwn(profiles, deviceKey)) {
        const profile = profiles[deviceKey];
        if (profile) {
            return { key: deviceKey, profile };
        }
    }

    const normalizedDescription = normalizeDeviceDescription(description);
    if (!normalizedDescription) {
        return null;
    }

    const matches = Object.entries(profiles).filter(
        ([, profile]) => normalizeDeviceDescription(profile.description) === normalizedDescription,
    );
    if (matches.length !== 1) {
        return null;
    }

    const [key, profile] = matches[0];
    return { key, profile };
}

export function resolveEffectivePlaybackPolicy(
    globalSelection: PlaybackPolicySelection,
    profiles: DeviceProfileMap | null | undefined,
    deviceId: null | string | undefined,
    description: null | string | undefined,
): PlaybackPolicy {
    return resolveEffectivePlaybackPolicyDecision(globalSelection, profiles, deviceId, description)
        .policy;
}

/**
 * Resolves the policy that drives behavior. A matching profile's explicit
 * override always beats the global selection; a global `auto` selection then
 * runs the conservative device-class heuristic. The decision carries the auto
 * explanation for Signal Path disclosure.
 */
export function resolveEffectivePlaybackPolicyDecision(
    globalSelection: PlaybackPolicySelection,
    profiles: DeviceProfileMap | null | undefined,
    deviceId: null | string | undefined,
    description: null | string | undefined,
): EffectivePlaybackPolicyDecision {
    const selection =
        resolveDeviceProfile(profiles, deviceId, description)?.profile.policyOverride ??
        globalSelection;
    if (selection !== 'auto') {
        return { auto: null, policy: selection };
    }
    const auto = resolveAutoDevicePolicy(deviceId, description);
    return { auto, policy: auto.policy };
}

function isPlaybackPolicy(value: unknown): value is PlaybackPolicy {
    return normalizePlaybackPolicy(value) === value;
}

function matchesDevicePattern(facts: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => facts.includes(pattern));
}

import { normalizePlaybackPolicy, type PlaybackPolicy } from './policy';

export interface DeviceProfile {
    description: null | string;
    policyOverride: PlaybackPolicy;
}

export type DeviceProfileMap = Record<string, DeviceProfile>;

export interface ResolvedDeviceProfile {
    key: string;
    profile: DeviceProfile;
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
        if (!deviceId || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
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

/**
 * Resolves the profile for a device: exact mpv id first, then a unique
 * normalized-description match for replug stability. Ambiguous descriptions
 * resolve to null so a shared name never silently applies the wrong policy.
 */
export function resolveDeviceProfile(
    profiles: DeviceProfileMap,
    deviceId: null | string | undefined,
    description: null | string | undefined,
): null | ResolvedDeviceProfile {
    const trimmedId = deviceId?.trim();
    if (trimmedId && Object.hasOwn(profiles, trimmedId)) {
        const profile = profiles[trimmedId];
        if (profile) {
            return { key: trimmedId, profile };
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
    globalPolicy: PlaybackPolicy,
    profiles: DeviceProfileMap,
    deviceId: null | string | undefined,
    description: null | string | undefined,
): PlaybackPolicy {
    return (
        resolveDeviceProfile(profiles, deviceId, description)?.profile.policyOverride ??
        globalPolicy
    );
}

function isPlaybackPolicy(value: unknown): value is PlaybackPolicy {
    return normalizePlaybackPolicy(value) === value;
}

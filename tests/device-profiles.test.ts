import { describe, expect, it } from 'vitest';

import {
    type AutoDevicePolicyDecision,
    type DeviceProfileMap,
    normalizeDeviceDescription,
    normalizeDeviceProfiles,
    normalizeMpvDeviceId,
    type PlaybackPolicy,
    resolveAutoDevicePolicy,
    resolveDeviceProfile,
    resolveEffectivePlaybackPolicy,
    resolveEffectivePlaybackPolicyDecision,
} from '../src/shared/signalpath';

const profile = (
    description: null | string,
    policyOverride: PlaybackPolicy = 'bit-perfect',
): DeviceProfileMap[string] => ({ description, policyOverride });

const USB_DAC_ID = 'coreaudio/AppleUSBAudioEngine:Burr-Brown:usb-dac:1';
const USB_DAC_DESCRIPTION = 'USB  DAC';

describe('normalizeDeviceDescription', () => {
    it('trims, collapses internal whitespace, and lowercases', () => {
        expect(normalizeDeviceDescription('  USB   DAC \n')).toBe('usb dac');
    });

    it.each([undefined, null, '', '   '])('treats %s as no description', (value) => {
        expect(normalizeDeviceDescription(value)).toBeNull();
    });
});

describe('normalizeMpvDeviceId', () => {
    it('treats a missing or blank device id as the mpv auto device', () => {
        expect(normalizeMpvDeviceId(undefined)).toBe('auto');
        expect(normalizeMpvDeviceId(null)).toBe('auto');
        expect(normalizeMpvDeviceId('  ')).toBe('auto');
        expect(normalizeMpvDeviceId(' coreaudio/BuiltInSpeakerDevice ')).toBe(
            'coreaudio/BuiltInSpeakerDevice',
        );
    });
});

describe('resolveDeviceProfile', () => {
    it('matches by exact device id first', () => {
        const profiles: DeviceProfileMap = {
            [USB_DAC_ID]: profile('Some other description', 'exclusive'),
        };

        const resolved = resolveDeviceProfile(profiles, USB_DAC_ID, USB_DAC_DESCRIPTION);

        expect(resolved).toEqual({
            key: USB_DAC_ID,
            profile: profile('Some other description', 'exclusive'),
        });
    });

    it('resolves the auto profile when no device id is configured', () => {
        const profiles: DeviceProfileMap = { auto: profile('Autoselect device') };

        expect(resolveDeviceProfile(profiles, undefined, undefined)).toEqual({
            key: 'auto',
            profile: profile('Autoselect device'),
        });
    });

    it('prefers an explicit device id over the auto profile', () => {
        const profiles: DeviceProfileMap = {
            auto: profile('Autoselect device'),
            [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION, 'exclusive'),
        };

        expect(resolveDeviceProfile(profiles, USB_DAC_ID, USB_DAC_DESCRIPTION)).toEqual({
            key: USB_DAC_ID,
            profile: profile(USB_DAC_DESCRIPTION, 'exclusive'),
        });
    });

    it('falls back to a unique normalized description match when the id changed', () => {
        // Replug: the mpv id is unstable, but the description is not.
        const profiles: DeviceProfileMap = { [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION) };

        const resolved = resolveDeviceProfile(
            profiles,
            'coreaudio/new-enumeration-order',
            'usb dac',
        );

        expect(resolved).toEqual({ key: USB_DAC_ID, profile: profile(USB_DAC_DESCRIPTION) });
    });

    it('ignores ambiguous description matches', () => {
        const profiles: DeviceProfileMap = {
            'coreaudio/left': profile('Speakers'),
            'coreaudio/right': profile('Speakers'),
        };

        expect(resolveDeviceProfile(profiles, 'coreaudio/unknown', 'Speakers')).toBeNull();
    });

    it('never matches entries without a description', () => {
        const profiles: DeviceProfileMap = { 'coreaudio/legacy': profile(null) };

        expect(resolveDeviceProfile(profiles, 'coreaudio/other', 'USB DAC')).toBeNull();
    });

    it('returns null without a device id or description', () => {
        const profiles: DeviceProfileMap = { [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION) };

        expect(resolveDeviceProfile(profiles, undefined, undefined)).toBeNull();
        expect(resolveDeviceProfile(profiles, '', '  ')).toBeNull();
        expect(resolveDeviceProfile({}, USB_DAC_ID, USB_DAC_DESCRIPTION)).toBeNull();
    });

    it('tolerates a missing profile map from corrupt persisted state', () => {
        expect(resolveDeviceProfile(undefined, USB_DAC_ID, USB_DAC_DESCRIPTION)).toBeNull();
        expect(resolveDeviceProfile(null, USB_DAC_ID, USB_DAC_DESCRIPTION)).toBeNull();
    });
});

describe('resolveEffectivePlaybackPolicy', () => {
    it('uses the global policy when no profile matches', () => {
        expect(resolveEffectivePlaybackPolicy('bit-perfect', {}, undefined, undefined)).toBe(
            'bit-perfect',
        );
        expect(
            resolveEffectivePlaybackPolicy('standard', {}, USB_DAC_ID, USB_DAC_DESCRIPTION),
        ).toBe('standard');
        expect(
            resolveEffectivePlaybackPolicy('standard', null, USB_DAC_ID, USB_DAC_DESCRIPTION),
        ).toBe('standard');
    });

    it('applies the auto profile to the default (unset) device selection', () => {
        const profiles: DeviceProfileMap = { auto: profile('Autoselect device') };

        expect(resolveEffectivePlaybackPolicy('standard', profiles, undefined, undefined)).toBe(
            'bit-perfect',
        );
    });

    it('consumes the profile override before the global default', () => {
        const profiles: DeviceProfileMap = { [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION) };

        expect(
            resolveEffectivePlaybackPolicy('standard', profiles, USB_DAC_ID, USB_DAC_DESCRIPTION),
        ).toBe('bit-perfect');
    });

    it('degrades to the description match after a replug changes the device id', () => {
        const profiles: DeviceProfileMap = { [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION) };

        expect(
            resolveEffectivePlaybackPolicy(
                'standard',
                profiles,
                'coreaudio/new-enumeration-order',
                'USB DAC',
            ),
        ).toBe('bit-perfect');
    });

    it('falls back to global when a description is ambiguous', () => {
        const profiles: DeviceProfileMap = {
            'coreaudio/a': profile('USB DAC'),
            'coreaudio/b': profile('USB DAC', 'exclusive'),
        };

        expect(resolveEffectivePlaybackPolicy('standard', profiles, 'coreaudio/c', 'USB DAC')).toBe(
            'standard',
        );
    });

    it('lets a profile override standard even while the global policy is strict', () => {
        const profiles: DeviceProfileMap = {
            [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION, 'standard'),
        };

        expect(
            resolveEffectivePlaybackPolicy(
                'bit-perfect',
                profiles,
                USB_DAC_ID,
                USB_DAC_DESCRIPTION,
            ),
        ).toBe('standard');
    });

    it('leaves orphan profiles harmless for devices that are not selected', () => {
        const profiles: DeviceProfileMap = { [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION) };

        expect(
            resolveEffectivePlaybackPolicy(
                'standard',
                profiles,
                'coreaudio/builtin',
                'MacBook Pro Speakers',
            ),
        ).toBe('standard');
    });

    it('resolves the auto selection to the device-class policy', () => {
        expect(resolveEffectivePlaybackPolicy('auto', {}, USB_DAC_ID, USB_DAC_DESCRIPTION)).toBe(
            'exclusive',
        );
        expect(
            resolveEffectivePlaybackPolicy(
                'auto',
                {},
                'wasapi/{guid}',
                'Speakers (High Definition Audio)',
            ),
        ).toBe('standard');
    });
});

describe('resolveAutoDevicePolicy', () => {
    const CASES: {
        description: null | string;
        deviceId: null | string | undefined;
        expected: AutoDevicePolicyDecision;
        name: string;
    }[] = [
        {
            description: 'USB DAC',
            deviceId: USB_DAC_ID,
            expected: { level: 'inferred', policy: 'exclusive', reason: 'external-device' },
            name: 'a USB audio class device on coreaudio',
        },
        {
            description: 'Topping E30 USB DAC',
            deviceId: 'wasapi/{guid}',
            expected: { level: 'inferred', policy: 'exclusive', reason: 'external-device' },
            name: 'a USB DAC described only by name on wasapi',
        },
        {
            description: 'Audio',
            deviceId: 'alsa/hw:CARD=Audio,DEV=0',
            expected: { level: 'unknown', policy: 'standard', reason: 'unknown-device' },
            name: 'a bare ALSA hw id (built-in cards use the same shape)',
        },
        {
            description: 'MacBook Pro Speakers',
            deviceId: 'coreaudio/BuiltInSpeakerDevice',
            expected: { level: 'inferred', policy: 'standard', reason: 'built-in-device' },
            name: 'the built-in speakers',
        },
        {
            description: 'Speakers (Realtek(R) Audio)',
            deviceId: 'wasapi/{guid}',
            expected: { level: 'inferred', policy: 'standard', reason: 'built-in-device' },
            name: 'a built-in Realtek codec',
        },
        {
            description: 'Realtek USB Audio',
            deviceId: 'wasapi/{guid}',
            expected: { level: 'inferred', policy: 'exclusive', reason: 'external-device' },
            name: 'an external USB codec whose vendor name is also a built-in one',
        },
        {
            description: 'Topping E30 DAC',
            deviceId: 'wasapi/{guid}',
            expected: { level: 'inferred', policy: 'exclusive', reason: 'external-device' },
            name: 'a DAC named only by its label',
        },
        {
            description: null,
            deviceId: USB_DAC_ID,
            expected: { level: 'inferred', policy: 'exclusive', reason: 'external-device' },
            name: 'a USB audio class id without a stored description',
        },
        {
            description: 'Medac Reference Speakers',
            deviceId: 'wasapi/{guid}',
            expected: { level: 'unknown', policy: 'standard', reason: 'unknown-device' },
            name: 'a label word that merely contains the letters dac',
        },
        {
            description: 'Speakers (High Definition Audio)',
            deviceId: 'wasapi/{0.0.0.00000000}.{dac4e1b2-0000-0000-0000-000000000000}',
            expected: { level: 'unknown', policy: 'standard', reason: 'unknown-device' },
            name: 'an opaque GUID endpoint that merely contains the letters dac',
        },
        {
            description: 'AirPods Pro',
            deviceId: 'coreaudio/AirPods Pro',
            expected: { level: 'inferred', policy: 'standard', reason: 'wireless-device' },
            name: 'AirPods',
        },
        {
            description: 'Bluetooth Speaker',
            deviceId: 'wasapi/{guid}',
            expected: { level: 'inferred', policy: 'standard', reason: 'wireless-device' },
            name: 'a Bluetooth endpoint',
        },
        {
            description: 'BlackHole 2ch',
            deviceId: 'coreaudio/BlackHole 2ch',
            expected: { level: 'inferred', policy: 'standard', reason: 'virtual-device' },
            name: 'a virtual loopback device',
        },
        {
            description: 'Speakers (High Definition Audio)',
            deviceId: 'wasapi/{guid}',
            expected: { level: 'unknown', policy: 'standard', reason: 'unknown-device' },
            name: 'an unclassifiable device',
        },
        {
            description: 'Autoselect device',
            deviceId: undefined,
            expected: { level: 'unknown', policy: 'standard', reason: 'no-device' },
            name: 'no explicit device selection',
        },
        {
            description: 'Autoselect device',
            deviceId: 'auto',
            expected: { level: 'unknown', policy: 'standard', reason: 'no-device' },
            name: 'the mpv auto device',
        },
    ];

    it.each(CASES)('classifies $name', ({ description, deviceId, expected }) => {
        expect(resolveAutoDevicePolicy(deviceId, description)).toEqual(expected);
    });

    it('never selects strict enforcement (Bit-Perfect), whatever the device', () => {
        for (const testCase of CASES) {
            expect(
                resolveAutoDevicePolicy(testCase.deviceId, testCase.description).policy,
            ).not.toBe('bit-perfect');
        }
    });

    it('lets an exclusion win over a positive external match', () => {
        expect(resolveAutoDevicePolicy('coreaudio/BlackHole 2ch USB', 'BlackHole 2ch USB')).toEqual(
            {
                level: 'inferred',
                policy: 'standard',
                reason: 'virtual-device',
            },
        );
        expect(resolveAutoDevicePolicy(USB_DAC_ID, 'Bluetooth USB DAC')).toEqual({
            level: 'inferred',
            policy: 'standard',
            reason: 'wireless-device',
        });
    });
});

describe('resolveEffectivePlaybackPolicyDecision', () => {
    it('reports a concrete global policy without an auto decision', () => {
        expect(
            resolveEffectivePlaybackPolicyDecision(
                'exclusive',
                {},
                USB_DAC_ID,
                USB_DAC_DESCRIPTION,
            ),
        ).toEqual({ auto: null, policy: 'exclusive' });
    });

    it('resolves an auto global for the selected device', () => {
        expect(
            resolveEffectivePlaybackPolicyDecision('auto', {}, USB_DAC_ID, USB_DAC_DESCRIPTION),
        ).toEqual({
            auto: { level: 'inferred', policy: 'exclusive', reason: 'external-device' },
            policy: 'exclusive',
        });
    });

    it('resolves auto to standard for built-in and unrecognized devices', () => {
        expect(
            resolveEffectivePlaybackPolicyDecision(
                'auto',
                {},
                'coreaudio/BuiltInSpeakerDevice',
                'MacBook Pro Speakers',
            ).policy,
        ).toBe('standard');
        expect(
            resolveEffectivePlaybackPolicyDecision(
                'auto',
                {},
                'wasapi/{guid}',
                'Speakers (High Definition Audio)',
            ).policy,
        ).toBe('standard');
    });

    it('lets an explicit profile beat auto for the same device', () => {
        const profiles: DeviceProfileMap = {
            [USB_DAC_ID]: profile(USB_DAC_DESCRIPTION, 'standard'),
        };

        expect(
            resolveEffectivePlaybackPolicyDecision(
                'auto',
                profiles,
                USB_DAC_ID,
                USB_DAC_DESCRIPTION,
            ),
        ).toEqual({ auto: null, policy: 'standard' });
    });

    it('lets a profile opt a built-in device into strict enforcement', () => {
        const profiles: DeviceProfileMap = {
            'coreaudio/builtin': profile('MacBook Pro Speakers', 'bit-perfect'),
        };

        expect(
            resolveEffectivePlaybackPolicyDecision(
                'auto',
                profiles,
                'coreaudio/builtin',
                'MacBook Pro Speakers',
            ),
        ).toEqual({ auto: null, policy: 'bit-perfect' });
    });
});

describe('normalizeDeviceProfiles', () => {
    it.each([undefined, null, 'nope', 42, ['x']])('collapses %s to an empty map', (value) => {
        expect(normalizeDeviceProfiles(value)).toEqual({});
    });

    it('preserves valid entries and trims device id keys', () => {
        const normalized = normalizeDeviceProfiles({
            'coreaudio/legacy': { description: null, policyOverride: 'standard' },
            ' usb-dac ': { description: 'USB DAC', policyOverride: 'exclusive' },
        });

        expect(normalized).toEqual({
            'coreaudio/legacy': { description: null, policyOverride: 'standard' },
            'usb-dac': { description: 'USB DAC', policyOverride: 'exclusive' },
        });
    });

    it('drops entries whose override is not a known policy instead of inventing one', () => {
        expect(normalizeDeviceProfiles({ 'usb-dac': { policyOverride: 'hifi' } })).toEqual({});
    });

    it('drops malformed entries and blank keys', () => {
        expect(
            normalizeDeviceProfiles({
                '': { description: 'USB DAC', policyOverride: 'bit-perfect' },
                'usb-dac': null,
                'wasapi/{guid}': 'nope',
            }),
        ).toEqual({});
    });

    it('drops prototype-mutating keys from persisted payloads', () => {
        // JSON.parse creates own properties, including a literal __proto__ key.
        const persisted = JSON.parse(
            '{"__proto__":{"description":"evil","policyOverride":"bit-perfect"},' +
                '"constructor":{"policyOverride":"bit-perfect"},' +
                '"usb-dac":{"policyOverride":"standard"}}',
        ) as unknown;

        const normalized = normalizeDeviceProfiles(persisted);

        expect(normalized).toEqual({
            'usb-dac': { description: null, policyOverride: 'standard' },
        });
        expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    });

    it('coerces a missing description to null', () => {
        expect(normalizeDeviceProfiles({ 'usb-dac': { policyOverride: 'bit-perfect' } })).toEqual({
            'usb-dac': { description: null, policyOverride: 'bit-perfect' },
        });
    });
});

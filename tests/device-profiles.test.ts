import { describe, expect, it } from 'vitest';

import {
    type DeviceProfileMap,
    normalizeDeviceDescription,
    normalizeDeviceProfiles,
    type PlaybackPolicy,
    resolveDeviceProfile,
    resolveEffectivePlaybackPolicy,
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
});

describe('resolveEffectivePlaybackPolicy', () => {
    it('uses the global policy when no profile matches', () => {
        expect(resolveEffectivePlaybackPolicy('bit-perfect', {}, undefined, undefined)).toBe(
            'bit-perfect',
        );
        expect(
            resolveEffectivePlaybackPolicy('standard', {}, USB_DAC_ID, USB_DAC_DESCRIPTION),
        ).toBe('standard');
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

    it('coerces a missing description to null', () => {
        expect(normalizeDeviceProfiles({ 'usb-dac': { policyOverride: 'bit-perfect' } })).toEqual({
            'usb-dac': { description: null, policyOverride: 'bit-perfect' },
        });
    });
});

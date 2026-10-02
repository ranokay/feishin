import type { SourceDecodeOptions } from './source-decode';

import { describeAfEntry, isSourceDecodeActive } from './source-decode';

export type StrictPropertyName = keyof StrictPropertyValues;

export type StrictPropertyPin = {
    [Name in StrictPropertyName]: { name: Name; value: StrictPropertyValues[Name] };
}[StrictPropertyName];

export interface StrictPropertyViolation {
    actual: string;
    expected: string;
    property: StrictPropertyName;
}

interface StrictPropertyValues {
    af: unknown[];
    'audio-samplerate': number;
    'gapless-audio': 'weak';
    replaygain: 'no';
    speed: number;
    volume: number;
}

export const BIT_PERFECT_PROPERTY_PINS: readonly StrictPropertyPin[] = [
    { name: 'af', value: [] },
    { name: 'audio-samplerate', value: 0 },
    { name: 'gapless-audio', value: 'weak' },
    { name: 'replaygain', value: 'no' },
    { name: 'speed', value: 1 },
    { name: 'volume', value: 100 },
];

export function findStrictPropertyViolation(
    pin: StrictPropertyPin,
    actual: unknown,
): null | StrictPropertyViolation {
    if (pin.name === 'af') {
        if (Array.isArray(actual) && actual.length === 0) {
            return null;
        }
        const filters = readFilterNames(actual);
        return {
            actual: filters.length > 0 ? filters.join(',') : describeValue(actual),
            expected: 'none',
            property: pin.name,
        };
    }
    // mpv's JSON IPC represents the replaygain choice `no` as boolean false.
    if (pin.name === 'replaygain' && actual === false) {
        return null;
    }
    if (actual === pin.value) {
        return null;
    }
    return {
        actual: describeValue(actual),
        expected: describeValue(pin.value),
        property: pin.name,
    };
}

/**
 * An explicit source-faithful decode is user-intended processing, so repairing
 * `af` back to empty would delete the opted filter. The pin is lifted while a
 * decode is active; the Signal Path still reports the observed chain and the
 * verdict can never reach bit-perfect.
 */
export function strictPropertyPinsForSourceDecode(
    options: SourceDecodeOptions,
): readonly StrictPropertyPin[] {
    return isSourceDecodeActive(options)
        ? BIT_PERFECT_PROPERTY_PINS.filter((pin) => pin.name !== 'af')
        : BIT_PERFECT_PROPERTY_PINS;
}

export function strictPropertyRecord(pins: readonly StrictPropertyPin[]): Record<string, unknown> {
    return Object.fromEntries(pins.map((pin) => [pin.name, pin.value]));
}

function describeValue(value: unknown): string {
    if (value === null || value === undefined || value === '') {
        return 'unset';
    }
    if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
    }
    return JSON.stringify(value) ?? 'unrecognized';
}

function readFilterNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return typeof value === 'string' && value.length > 0 ? [value] : [];
    }
    return value.map(describeAfEntry).filter((name) => name.length > 0);
}

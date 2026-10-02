import { describe, expect, it } from 'vitest';

import {
    classifySourceDecodeFilter,
    declaresDeEmphasis,
    DEFAULT_SOURCE_DECODE_OPTIONS,
    isSourceDecodeActive,
    normalizeSourceDecodeOptions,
    sourceDecodeFilterEntries,
} from '../src/shared/signalpath';
import {
    BIT_PERFECT_PROPERTY_PINS,
    strictPropertyPinsForSourceDecode,
} from '../src/shared/signalpath/strict-properties';

describe('normalizeSourceDecodeOptions', () => {
    it('defaults both options to off', () => {
        expect(normalizeSourceDecodeOptions(undefined)).toEqual(DEFAULT_SOURCE_DECODE_OPTIONS);
        expect(normalizeSourceDecodeOptions(null)).toEqual(DEFAULT_SOURCE_DECODE_OPTIONS);
        expect(normalizeSourceDecodeOptions('hdcd')).toEqual(DEFAULT_SOURCE_DECODE_OPTIONS);
    });

    it('keeps explicit true booleans and rejects everything else', () => {
        expect(normalizeSourceDecodeOptions({ hdcd: true })).toEqual({
            deEmphasis: false,
            hdcd: true,
        });
        expect(normalizeSourceDecodeOptions({ deEmphasis: true, hdcd: true })).toEqual({
            deEmphasis: true,
            hdcd: true,
        });
        expect(normalizeSourceDecodeOptions({ deEmphasis: 1, hdcd: 'yes' })).toEqual(
            DEFAULT_SOURCE_DECODE_OPTIONS,
        );
    });
});

describe('isSourceDecodeActive', () => {
    it('is true when either option is enabled', () => {
        expect(isSourceDecodeActive(DEFAULT_SOURCE_DECODE_OPTIONS)).toBe(false);
        expect(isSourceDecodeActive({ deEmphasis: false, hdcd: true })).toBe(true);
        expect(isSourceDecodeActive({ deEmphasis: true, hdcd: false })).toBe(true);
    });
});

describe('sourceDecodeFilterEntries', () => {
    it('returns nothing when both options are off', () => {
        expect(sourceDecodeFilterEntries(DEFAULT_SOURCE_DECODE_OPTIONS)).toEqual([]);
    });

    it('returns the lavfi entries in decode order', () => {
        expect(sourceDecodeFilterEntries({ deEmphasis: false, hdcd: true })).toEqual([
            'lavfi=[hdcd]',
        ]);
        expect(sourceDecodeFilterEntries({ deEmphasis: true, hdcd: false })).toEqual([
            'lavfi=[aemphasis=type=cd]',
        ]);
        expect(sourceDecodeFilterEntries({ deEmphasis: true, hdcd: true })).toEqual([
            'lavfi=[hdcd]',
            'lavfi=[aemphasis=type=cd]',
        ]);
    });
});

describe('classifySourceDecodeFilter', () => {
    it('recognizes hdcd entries', () => {
        expect(classifySourceDecodeFilter('lavfi:hdcd')).toBe('hdcd');
        expect(classifySourceDecodeFilter('lavfi:hdcd=force_pe=1')).toBe('hdcd');
        expect(classifySourceDecodeFilter(' LAVFI:HDCD ')).toBe('hdcd');
    });

    it('recognizes only the cd de-emphasis curve', () => {
        expect(classifySourceDecodeFilter('lavfi:aemphasis=type=cd')).toBe('deEmphasis');
        expect(classifySourceDecodeFilter('lavfi:aemphasis=level_in=1:type=cd')).toBe('deEmphasis');
        expect(classifySourceDecodeFilter('lavfi:aemphasis=type=col')).toBeNull();
        expect(classifySourceDecodeFilter('lavfi:aemphasis')).toBeNull();
    });

    it('leaves other filters unclassified', () => {
        expect(classifySourceDecodeFilter('lavfi:equalizer=f=1000:t=q:w=1:g=6')).toBeNull();
        expect(classifySourceDecodeFilter('volume')).toBeNull();
        expect(classifySourceDecodeFilter('')).toBeNull();
    });
});

describe('declaresDeEmphasis', () => {
    it('accepts the documented tag keys with truthy values', () => {
        expect(declaresDeEmphasis({ PREEMPHASIS: ['1'] })).toBe(true);
        expect(declaresDeEmphasis({ 'pre-emphasis': ['true'] })).toBe(true);
        expect(declaresDeEmphasis({ pre_emphasis: ['on'] })).toBe(true);
        expect(declaresDeEmphasis({ deemphasis: ['YES'] })).toBe(true);
        expect(declaresDeEmphasis({ cd_deemphasis: ['CD'] })).toBe(true);
    });

    it('rejects falsey values, empty lists, and unrelated tags', () => {
        expect(declaresDeEmphasis(null)).toBe(false);
        expect(declaresDeEmphasis({})).toBe(false);
        expect(declaresDeEmphasis({ deemphasis: ['0'] })).toBe(false);
        expect(declaresDeEmphasis({ deemphasis: ['false'] })).toBe(false);
        expect(declaresDeEmphasis({ deemphasis: ['off'] })).toBe(false);
        expect(declaresDeEmphasis({ deemphasis: [] })).toBe(false);
        expect(declaresDeEmphasis({ mood: ['happy'] })).toBe(false);
    });
});

describe('strictPropertyPinsForSourceDecode', () => {
    it('keeps the standard pins when no source decode is enabled', () => {
        expect(strictPropertyPinsForSourceDecode(DEFAULT_SOURCE_DECODE_OPTIONS)).toEqual(
            BIT_PERFECT_PROPERTY_PINS,
        );
    });

    it('lifts only the af pin when an explicit decode is enabled', () => {
        const pins = strictPropertyPinsForSourceDecode({ deEmphasis: true, hdcd: true });
        expect(pins.some((pin) => pin.name === 'af')).toBe(false);
        expect(pins).toEqual(BIT_PERFECT_PROPERTY_PINS.filter((pin) => pin.name !== 'af'));
    });
});

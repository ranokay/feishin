import type { ConfidenceLevel, Evidence } from './evidence';
import type { DecodedParams } from './formats';
import type { Platform } from './policy';

import { normalizeMpvDeviceId } from './device-profiles';

export interface CoreAudioFormatLine extends PhysicalFormatEntry {
    bitsPerChannel: null | number;
    formatId: null | string;
    mpFormat: null | string;
    role: CoreAudioFormatRole;
}

export type CoreAudioFormatRole =
    | 'active'
    | 'available'
    | 'our-format'
    | 'previous'
    | 'requested'
    | 'virtual';

export interface DeviceCapabilityEntry {
    /** The active row of a physical-format table, when one matches. */
    activeFormat: null | PhysicalFormatEntry;
    detail: 'exclusive-requested' | null;
    field: DeviceCapabilityField;
    formats: null | PhysicalFormatEntry[];
    level: ConfidenceLevel;
    /** Why the value is unknowable; only set when level is unknown. */
    reason: DeviceCapabilityReason | null;
    value: null | string;
}

export type DeviceCapabilityField =
    | 'device'
    | 'dsd'
    | 'hardwareVolume'
    | 'output'
    | 'physicalFormats'
    | 'route';

export interface DeviceCapabilityInput {
    availablePhysicalFormats: null | PhysicalFormatEntry[];
    deviceDescription: null | string;
    deviceId: null | string;
    /** Device id mpv reports as configured; null when no session was observed. */
    observedDeviceId: null | string;
    outputParams: DecodedParams | null;
    physicalFormat: Evidence<string> | null;
    platform: Platform;
    requestedExclusive: boolean;
    route: null | string;
}

export type DeviceCapabilityReason =
    | 'device-not-active'
    | 'dsd-unsupported'
    | 'exclusive-session-pending'
    | 'exclusive-session-required'
    | 'hardware-volume-unavailable'
    | 'no-session'
    | 'platform-unavailable';

/**
 * Physical-format rows as printed by mpv's ca_print_asbd (ao/coreaudio_exclusive
 * v-level logs). The grammar is byte-identical across mpv 0.38-0.41; parse
 * failures must stay empty rather than guess.
 */
export interface PhysicalFormatEntry {
    channels: null | number;
    format: null | string;
    label: string;
    sampleRate: null | number;
}

const FORMAT_LINE_ROLES: [string, CoreAudioFormatRole][] = [
    ['format in use before switching:', 'previous'],
    ['setting stream physical format:', 'requested'],
    ['our format:', 'our-format'],
    ['actual format in use:', 'active'],
    ['virtual format', 'virtual'],
    ['- ', 'available'],
];

// "96000.0Hz 32bit lpcm [9][4bpp][1fbp][4bpf][2ch] float LE U packed (float)"
// The bracket tail and the trailing mpv format name are optional so partial
// init logs still parse instead of silently dropping rows.
const ASBD_PATTERN =
    /(\d+(?:\.\d+)?)Hz\s+(\d+)bit\s+(\S+)\s*(?:\[\d+\]\[\d+bpp\]\[\d+fbp\]\[\d+bpf\]\[(\d+)ch\]\s*.*?\(([^)]+)\))?\s*$/;

export function assembleDeviceCapabilities(input: DeviceCapabilityInput): DeviceCapabilityEntry[] {
    const formats = input.availablePhysicalFormats ?? [];
    const activeFormat =
        formats.find((format) => format.label === input.physicalFormat?.value) ?? null;
    const deviceConfirmed = isSelectedDeviceActive(input);

    return [
        deviceEntry(input, deviceConfirmed),
        routeEntry(input, deviceConfirmed),
        outputEntry(input, deviceConfirmed),
        physicalFormatsEntry(input, formats, activeFormat, deviceConfirmed),
        {
            activeFormat: null,
            detail: null,
            field: 'dsd',
            formats: null,
            level: 'unknown',
            reason: 'dsd-unsupported',
            value: null,
        },
        {
            activeFormat: null,
            detail: null,
            field: 'hardwareVolume',
            formats: null,
            level: 'unknown',
            reason: 'hardware-volume-unavailable',
            value: null,
        },
    ];
}

export function parseCoreAudioFormatLine(text: string): CoreAudioFormatLine | null {
    const trimmed = text.trim();
    const match = FORMAT_LINE_ROLES.map(([prefix, role]) => ({
        remainder: trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : null,
        role,
    })).find((candidate) => candidate.remainder !== null);
    if (!match || match.remainder === null) {
        return null;
    }

    const parsed = ASBD_PATTERN.exec(match.remainder);
    if (!parsed) {
        return null;
    }

    const sampleRate = Number(parsed[1]);
    const bitsPerChannel = Number(parsed[2]);
    const formatId = parsed[3];
    const channels = parsed[4] === undefined ? null : Number(parsed[4]);
    const mpFormat = parsed[5] === undefined || parsed[5] === '-' ? null : parsed[5];
    const format = mpFormat ?? formatId;
    const label = `${formatRate(sampleRate)} / ${bitsPerChannel}-bit / ${channels ?? '?'}ch / ${format}`;

    return {
        bitsPerChannel,
        channels,
        format,
        formatId,
        label,
        mpFormat,
        role: match.role,
        sampleRate,
    };
}

function deviceEntry(
    input: DeviceCapabilityInput,
    deviceConfirmed: boolean,
): DeviceCapabilityEntry {
    if (!input.deviceId) {
        return {
            activeFormat: null,
            detail: null,
            field: 'device',
            formats: null,
            level: 'unknown',
            reason: 'no-session',
            value: null,
        };
    }
    return {
        activeFormat: null,
        detail: null,
        field: 'device',
        formats: null,
        level: deviceConfirmed ? 'confirmed' : 'requested',
        reason: null,
        value: input.deviceDescription
            ? `${input.deviceId} - ${input.deviceDescription}`
            : input.deviceId,
    };
}

function formatRate(rate: number): string {
    return `${Number.isInteger(rate) ? rate : rate.toFixed(1)} Hz`;
}

/** mpv has a session open, but on a different device than the selection. */
function isDeviceActiveElsewhere(input: DeviceCapabilityInput, deviceConfirmed: boolean): boolean {
    return input.deviceId !== null && input.observedDeviceId !== null && !deviceConfirmed;
}

/** mpv's observed configured device matches the picker selection. */
function isSelectedDeviceActive(input: DeviceCapabilityInput): boolean {
    return (
        input.deviceId !== null &&
        input.observedDeviceId !== null &&
        normalizeMpvDeviceId(input.deviceId) === normalizeMpvDeviceId(input.observedDeviceId)
    );
}

function outputEntry(
    input: DeviceCapabilityInput,
    deviceConfirmed: boolean,
): DeviceCapabilityEntry {
    if (isDeviceActiveElsewhere(input, deviceConfirmed)) {
        return {
            activeFormat: null,
            detail: null,
            field: 'output',
            formats: null,
            level: 'unknown',
            reason: 'device-not-active',
            value: null,
        };
    }
    const params = input.outputParams;
    const parts = [
        params?.format ?? null,
        params?.samplerate !== null && params?.samplerate !== undefined
            ? `${params.samplerate} Hz`
            : null,
        params?.channels !== null && params?.channels !== undefined ? `${params.channels}ch` : null,
    ].filter((part): part is string => part !== null);

    if (parts.length === 0) {
        return {
            activeFormat: null,
            detail: null,
            field: 'output',
            formats: null,
            level: 'unknown',
            reason: 'no-session',
            value: null,
        };
    }
    return {
        activeFormat: null,
        detail: null,
        field: 'output',
        formats: null,
        level: 'confirmed',
        reason: null,
        value: parts.join(' / '),
    };
}

function physicalFormatsEntry(
    input: DeviceCapabilityInput,
    formats: PhysicalFormatEntry[],
    activeFormat: null | PhysicalFormatEntry,
    deviceConfirmed: boolean,
): DeviceCapabilityEntry {
    if (formats.length > 0 && deviceConfirmed) {
        return {
            activeFormat,
            detail: null,
            field: 'physicalFormats',
            formats,
            level: 'inferred',
            reason: null,
            value: null,
        };
    }
    return {
        activeFormat: null,
        detail: null,
        field: 'physicalFormats',
        formats: null,
        level: 'unknown',
        reason: physicalFormatsReason(input, deviceConfirmed),
        value: null,
    };
}

function physicalFormatsReason(
    input: DeviceCapabilityInput,
    deviceConfirmed: boolean,
): DeviceCapabilityReason {
    if (input.platform !== 'darwin') {
        return 'platform-unavailable';
    }
    if (isDeviceActiveElsewhere(input, deviceConfirmed)) {
        return 'device-not-active';
    }
    return input.requestedExclusive ? 'exclusive-session-pending' : 'exclusive-session-required';
}

function routeEntry(input: DeviceCapabilityInput, deviceConfirmed: boolean): DeviceCapabilityEntry {
    if (isDeviceActiveElsewhere(input, deviceConfirmed)) {
        return {
            activeFormat: null,
            detail: null,
            field: 'route',
            formats: null,
            level: 'unknown',
            reason: 'device-not-active',
            value: null,
        };
    }
    if (input.route) {
        return {
            activeFormat: null,
            detail: input.requestedExclusive ? 'exclusive-requested' : null,
            field: 'route',
            formats: null,
            level: 'confirmed',
            reason: null,
            value: input.route,
        };
    }
    if (input.requestedExclusive) {
        return {
            activeFormat: null,
            detail: 'exclusive-requested',
            field: 'route',
            formats: null,
            level: 'requested',
            reason: null,
            value: null,
        };
    }
    return {
        activeFormat: null,
        detail: null,
        field: 'route',
        formats: null,
        level: 'unknown',
        reason: 'no-session',
        value: null,
    };
}

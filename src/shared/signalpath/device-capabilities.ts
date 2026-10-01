import type { ConfidenceLevel, Evidence } from './evidence';
import type { DecodedParams } from './formats';
import type { Platform } from './policy';

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

export const DEVICE_CAPABILITY_FIELDS = [
    'device',
    'route',
    'output',
    'physicalFormats',
    'dsd',
    'hardwareVolume',
] as const;

export interface DeviceCapabilityEntry {
    /** The active row of a physical-format table, when one matches. */
    activeFormat: null | PhysicalFormatEntry;
    detail: null | string;
    field: DeviceCapabilityField;
    formats: null | PhysicalFormatEntry[];
    level: ConfidenceLevel;
    /** Why the value is unknowable; only set when level is unknown. */
    reason: DeviceCapabilityReason | null;
    value: null | string;
}

export type DeviceCapabilityField = (typeof DEVICE_CAPABILITY_FIELDS)[number];

export interface DeviceCapabilityInput {
    availablePhysicalFormats: null | PhysicalFormatEntry[];
    deviceDescription: null | string;
    deviceId: null | string;
    outputParams: DecodedParams | null;
    physicalFormat: Evidence<string> | null;
    platform: Platform;
    requestedExclusive: boolean;
    route: null | string;
}

export type DeviceCapabilityReason =
    | 'dsd-unsupported'
    | 'exclusive-session-required'
    | 'hardware-volume-unavailable'
    | 'no-session'
    | 'platform-unavailable';

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

    return [
        {
            activeFormat: null,
            detail: null,
            field: 'device',
            formats: null,
            level: input.deviceId ? 'confirmed' : 'unknown',
            reason: input.deviceId ? null : 'no-session',
            value: input.deviceId
                ? input.deviceDescription
                    ? `${input.deviceId} - ${input.deviceDescription}`
                    : input.deviceId
                : null,
        },
        routeEntry(input),
        outputEntry(input),
        physicalFormatsEntry(input, formats, activeFormat),
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

function formatRate(rate: number): string {
    return `${Number.isInteger(rate) ? rate : rate.toFixed(1)} Hz`;
}

function outputEntry(input: DeviceCapabilityInput): DeviceCapabilityEntry {
    const params = input.outputParams;
    if (!params) {
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
        value: `${params.format ?? '?'} / ${params.samplerate ?? '?'} Hz / ${params.channels ?? '?'}ch`,
    };
}

function physicalFormatsEntry(
    input: DeviceCapabilityInput,
    formats: PhysicalFormatEntry[],
    activeFormat: null | PhysicalFormatEntry,
): DeviceCapabilityEntry {
    if (formats.length > 0) {
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
        reason: input.platform === 'darwin' ? 'exclusive-session-required' : 'platform-unavailable',
        value: null,
    };
}

function routeEntry(input: DeviceCapabilityInput): DeviceCapabilityEntry {
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
            detail: null,
            field: 'route',
            formats: null,
            level: 'requested',
            reason: null,
            value: 'exclusive',
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

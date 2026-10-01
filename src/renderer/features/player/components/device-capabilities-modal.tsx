import { openModal } from '@mantine/modals';
import { t } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { EvidenceDot } from './signal-path-rows';

import { useAudioSnapshot } from '/@/renderer/store/audio-state.store';
import { useEffectivePlaybackPolicy } from '/@/renderer/store/settings.store';
import { getPlatform } from '/@/renderer/utils/platform';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Badge } from '/@/shared/components/badge/badge';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { Table } from '/@/shared/components/table/table';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import {
    assembleDeviceCapabilities,
    type DeviceCapabilityEntry,
    type DeviceCapabilityField,
    type DeviceCapabilityReason,
} from '/@/shared/signalpath';

const FIELD_KEY: Record<DeviceCapabilityField, string> = {
    device: 'fieldDevice',
    dsd: 'fieldDsd',
    hardwareVolume: 'fieldHardwareVolume',
    output: 'fieldOutput',
    physicalFormats: 'fieldPhysicalFormats',
    route: 'fieldRoute',
};

const REASON_KEY: Record<DeviceCapabilityReason, string> = {
    'device-not-active': 'reasonDeviceNotActive',
    'dsd-unsupported': 'reasonDsd',
    'exclusive-session-pending': 'reasonExclusiveSessionPending',
    'exclusive-session-required': 'reasonExclusiveSession',
    'hardware-volume-unavailable': 'reasonHardwareVolume',
    'no-session': 'reasonNoSession',
    'platform-unavailable': 'reasonPlatform',
};

const CapabilityRow = ({ entry }: { entry: DeviceCapabilityEntry }) => {
    const { t: translate } = useTranslation();
    const label = translate(`player.deviceCapabilities_${FIELD_KEY[entry.field]}`);
    const row = (
        <Group align="flex-start" gap="xs" justify="space-between" wrap="nowrap">
            <Text c="dim" size="xs" style={{ flexShrink: 0 }}>
                {label}
            </Text>
            <Group gap="xs" wrap="nowrap">
                <Text size="xs">
                    {entry.level === 'unknown'
                        ? translate('player.deviceCapabilities_unknown')
                        : entry.value}
                </Text>
                {entry.detail === 'exclusive-requested' && (
                    <Text c="dim" size="xs">
                        {translate('player.deviceCapabilities_exclusiveRequested')}
                    </Text>
                )}
                <EvidenceDot level={entry.level} />
            </Group>
        </Group>
    );

    if (entry.level !== 'unknown' || !entry.reason) {
        return row;
    }

    return (
        <Tooltip
            label={translate(`player.deviceCapabilities_${REASON_KEY[entry.reason]}`)}
            multiline
            w={280}
        >
            {row}
        </Tooltip>
    );
};

const PhysicalFormatTable = ({ entry }: { entry: DeviceCapabilityEntry }) => {
    const { t: translate } = useTranslation();

    if (!entry.formats) {
        return <CapabilityRow entry={entry} />;
    }

    return (
        <Stack gap={4}>
            <Group justify="space-between" wrap="nowrap">
                <Text c="dim" size="xs">
                    {translate('player.deviceCapabilities_fieldPhysicalFormats')}
                </Text>
                <EvidenceDot level={entry.level} />
            </Group>
            <Table>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>{translate('player.deviceCapabilities_columnRate')}</Table.Th>
                        <Table.Th>{translate('player.deviceCapabilities_columnFormat')}</Table.Th>
                        <Table.Th>{translate('player.deviceCapabilities_columnChannels')}</Table.Th>
                        <Table.Th />
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {entry.formats.map((format) => (
                        <Table.Tr key={format.label}>
                            <Table.Td>
                                <Text size="xs">{format.sampleRate ?? '?'}</Text>
                            </Table.Td>
                            <Table.Td>
                                <Text size="xs">{format.format ?? '?'}</Text>
                            </Table.Td>
                            <Table.Td>
                                <Text size="xs">{format.channels ?? '?'}</Text>
                            </Table.Td>
                            <Table.Td>
                                {format.label === entry.activeFormat?.label && (
                                    <Badge size="xs">
                                        {translate('player.deviceCapabilities_active')}
                                    </Badge>
                                )}
                            </Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </Stack>
    );
};

export const DeviceCapabilitiesModal = ({
    deviceDescription,
    deviceId,
}: {
    deviceDescription: null | string;
    deviceId: string;
}) => {
    const policy = useEffectivePlaybackPolicy();
    const snapshot = useAudioSnapshot();

    const entries = useMemo(
        () =>
            assembleDeviceCapabilities({
                availablePhysicalFormats: snapshot?.availablePhysicalFormats?.value ?? null,
                deviceDescription,
                deviceId,
                observedDeviceId: snapshot?.audioDevice ?? null,
                outputParams: snapshot?.outputParams ?? null,
                physicalFormat: snapshot?.physicalFormat ?? null,
                platform: getPlatform(),
                requestedExclusive: policy === 'bit-perfect' || policy === 'exclusive',
                route: snapshot?.aoDriver ?? null,
            }),
        [deviceDescription, deviceId, policy, snapshot],
    );

    return (
        <Stack gap="sm">
            {entries.map((entry) =>
                entry.field === 'physicalFormats' ? (
                    <PhysicalFormatTable entry={entry} key={entry.field} />
                ) : (
                    <CapabilityRow entry={entry} key={entry.field} />
                ),
            )}
        </Stack>
    );
};

export const openDeviceCapabilities = ({
    description,
    deviceId,
}: {
    description: null | string;
    deviceId: string;
}) => {
    openModal({
        children: <DeviceCapabilitiesModal deviceDescription={description} deviceId={deviceId} />,
        size: 'lg',
        title: t('player.deviceCapabilities_title'),
    });
};

export const DeviceCapabilitiesButton = ({
    description,
    deviceId,
}: {
    description: null | string;
    deviceId: string;
}) => {
    const { t: translate } = useTranslation();

    return (
        <ActionIcon
            icon="info"
            iconProps={{ size: 'md' }}
            onClick={() => openDeviceCapabilities({ description, deviceId })}
            tooltip={{ label: translate('player.deviceCapabilities_title') }}
            variant="transparent"
        />
    );
};

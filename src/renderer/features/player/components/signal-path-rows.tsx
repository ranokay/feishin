import type { ConfidenceLevel } from '/@/shared/signalpath';
import type { ServerRouteEvidence, SignalPathItem } from '/@/shared/signalpath';

import { useTranslation } from 'react-i18next';

import styles from './signal-path-badge.module.css';

import { Group } from '/@/shared/components/group/group';
import { Text } from '/@/shared/components/text/text';

const EVIDENCE_KEY: Record<ConfidenceLevel, string> = {
    confirmed: 'evidenceConfirmed',
    inferred: 'evidenceInferred',
    requested: 'evidenceRequested',
    unknown: 'evidenceUnknown',
};

export const EvidenceDot = ({ level }: { level: ConfidenceLevel }) => {
    const { t } = useTranslation();

    return (
        <span
            aria-label={t(`player.signalPath_${EVIDENCE_KEY[level]}`)}
            className={styles.dot}
            data-level={level}
            title={t(`player.signalPath_${EVIDENCE_KEY[level]}`)}
        />
    );
};

export const StageRow = ({ item, label }: { item: SignalPathItem; label: string }) => (
    <Group align="flex-start" gap="xs" justify="space-between" wrap="nowrap">
        <Text c="dim" size="xs" style={{ flexShrink: 0 }}>
            {label}
        </Text>
        <Group gap="xs" wrap="nowrap">
            <Text size="xs">{item.detail ?? item.value ?? '-'}</Text>
            <EvidenceDot level={item.level} />
        </Group>
    </Group>
);

/**
 * Human-readable server stage line: label plus the verification method when
 * the route was positively verified (size-match/header-match/metadata-match).
 */
export function formatServerStage(
    route: null | ServerRouteEvidence | undefined,
    translate: (key: string) => string,
): string {
    if (!route || route.route === 'unverified') {
        return translate('player.signalPath_serverUnverified');
    }
    if (route.route === 'transcoded') {
        return [translate('player.signalPath_serverTranscoded'), route.detail]
            .filter((part): part is string => !!part && part.length > 0)
            .join(': ');
    }
    return `${translate('player.signalPath_serverDirect')} (${route.verification})`;
}

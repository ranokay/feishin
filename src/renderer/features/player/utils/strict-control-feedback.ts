import { t } from 'i18next';

import { toast } from '/@/shared/components/toast/toast';

export function showBitPerfectVolumeLockedToast(): void {
    toast.info({
        id: 'bit-perfect-volume-locked',
        message: t('player.bitPerfectVolumeLocked'),
    });
}

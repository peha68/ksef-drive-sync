/**
 * Alert mailowy uruchamiany przez systemd (OnFailure=), gdy usługa
 * ksef-drive-sync.service lub ksef-drive-sync-monthly.service zakończy się
 * błędem - w tym błędem, który nastąpił zanim skrypt zdążył sam wysłać
 * własne podsumowanie (np. wyjątek przy starcie, brak pliku .env).
 *
 * Wywoływane jako: node scripts/alert-failure.js <nazwa-jednostki-systemd>
 */
import { sendMail } from '../src/mailClient.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

const unitName = process.argv[2] || 'nieznana usługa ksef-drive-sync';

try {
  await sendMail({
    to: config.notifyEmail,
    subject: `[ksef-drive-sync] BŁĄD: ${unitName} zakończyła się niepowodzeniem`,
    text: [
      `Usługa systemd "${unitName}" zakończyła się błędem na serwerze.`,
      '',
      'Sprawdź szczegóły:',
      `  journalctl -u ${unitName} -n 50 --no-pager`,
      '',
      'To automatyczny alert wysłany przez OnFailure= w definicji usługi',
      '(patrz systemd/ksef-drive-sync-alert@.service) - oznacza to, że sama',
      'usługa nie zdążyła wysłać własnego podsumowania błędu mailem.',
    ].join('\n'),
  });
  logger.info(`Alert o awarii "${unitName}" wysłany na ${config.notifyEmail}.`);
} catch (err) {
  logger.error(`Nie udało się wysłać alertu o awarii "${unitName}": ${err.message}`);
  process.exit(1);
}

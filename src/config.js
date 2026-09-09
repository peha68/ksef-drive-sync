import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Brak wymaganej zmiennej środowiskowej: ${name} (sprawdź plik .env)`);
  }
  return value;
}

export const config = {
  ksef: {
    env: process.env.KSEF_ENV || 'test', // test | demo | prod
    nip: required('KSEF_NIP'),
    authToken: required('KSEF_AUTH_TOKEN'),
    subjectRole: process.env.KSEF_SUBJECT_ROLE || 'buyer', // buyer | seller | both
  },
  google: {
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
    refreshToken: required('GOOGLE_OAUTH_REFRESH_TOKEN'),
    rootFolderId: required('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
  },
  lookbackDays: parseInt(process.env.INVOICE_LOOKBACK_DAYS || '7', 10),
  logFile: process.env.LOG_FILE || './data/sync.log',
  notifyEmail: required('NOTIFY_EMAIL'),
  accounting: {
    email: process.env.ACCOUNTING_EMAIL || null,
    // Flaga bezpieczeństwa: dopóki 'false', archiwum miesięczne leci tylko na
    // NOTIFY_EMAIL (do testów), nawet jeśli ACCOUNTING_EMAIL jest ustawiony.
    sendToAccounting: (process.env.MONTHLY_ARCHIVE_SEND_TO_ACCOUNTING || 'false').toLowerCase() === 'true',
  },
};

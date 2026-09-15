import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Brak wymaganej zmiennej środowiskowej: ${name} (sprawdź plik .env)`);
  }
  return value;
}

// token: KSEF_AUTH_TOKEN wygenerowany w aplikacji KSeF - wygasa 31.12.2026.
// certificate: certyfikat KSeF (Typ 1, "uwierzytelnienie") - patrz README,
// sekcja "Uwierzytelnianie certyfikatem".
const ksefAuthMethod = (process.env.KSEF_AUTH_METHOD || 'token').toLowerCase();

export const config = {
  ksef: {
    env: process.env.KSEF_ENV || 'test', // test | demo | prod
    nip: required('KSEF_NIP'),
    authMethod: ksefAuthMethod,
    authToken: ksefAuthMethod === 'token' ? required('KSEF_AUTH_TOKEN') : process.env.KSEF_AUTH_TOKEN || null,
    certFile: ksefAuthMethod === 'certificate' ? required('KSEF_CERT_FILE') : process.env.KSEF_CERT_FILE || null,
    keyFile: ksefAuthMethod === 'certificate' ? required('KSEF_KEY_FILE') : process.env.KSEF_KEY_FILE || null,
    subjectRole: process.env.KSEF_SUBJECT_ROLE || 'buyer', // buyer | seller | both
  },
  google: {
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
    refreshToken: required('GOOGLE_OAUTH_REFRESH_TOKEN'),
    rootFolderId: required('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
    // Opcjonalne - rejestr faktur (patrz src/invoiceRegister.js). Nieustawione
    // = funkcja rejestru/dedup jest po prostu pomijana (sync działa jak dotąd).
    registerSheetId: process.env.GOOGLE_REGISTER_SHEET_ID || null,
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

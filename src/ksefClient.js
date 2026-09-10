/**
 * Wrapper wokół biblioteki `ksef-client-ts` (nieoficjalny, community pakiet npm
 * dla KSeF 2.0: https://github.com/Flopsstuff/ksef-client-ts).
 *
 * WAŻNE: to jest biblioteka firm trzecich, nie oficjalne SDK Ministerstwa
 * Finansów. Jej API zweryfikowano względem node_modules/ksef-client-ts@0.2.0
 * (dist/index.d.ts + dist/index.cjs). Przy zmianie wersji pakietu sprawdź
 * ponownie sygnatury poniżej.
 *
 * Ten moduł izoluje resztę aplikacji od konkretnej biblioteki - jeśli jej API
 * się zmieni, poprawki wystarczy zrobić tylko tutaj.
 */
import { readFileSync } from 'node:fs';
import { KSeFClient } from 'ksef-client-ts';
import { config } from './config.js';
import { logger } from './logger.js';

let clientInstance = null;

export async function getKsefClient() {
  if (clientInstance) return clientInstance;

  const environment = config.ksef.env.toUpperCase(); // TEST | DEMO | PROD

  const client = new KSeFClient({ environment });

  logger.info(
    `Autoryzacja w KSeF (${environment}) dla NIP ${config.ksef.nip} (metoda: ${config.ksef.authMethod})...`,
  );

  if (config.ksef.authMethod === 'certificate') {
    // client.loginWithCertificate(certPem, keyPem, nip) - certyfikat KSeF
    // Typ 1 ("uwierzytelnienie"), wygenerowany w Aplikacji Podatnika KSeF 2.0
    // (patrz README, sekcja "Uwierzytelnianie certyfikatem"). Docelowy
    // zamiennik tokenu, który wygasa 31.12.2026.
    const certPem = readFileSync(config.ksef.certFile, 'utf-8');
    const keyPem = readFileSync(config.ksef.keyFile, 'utf-8');
    await client.loginWithCertificate(certPem, keyPem, config.ksef.nip);
  } else {
    // client.loginWithToken(token, nip) - metoda wysokopoziomowa, sama robi
    // challenge -> szyfrowanie tokenu (crypto.init() wewnątrz) -> wymianę na
    // access/refresh token i zapisuje je w wewnętrznym authManagerze klienta.
    await client.loginWithToken(config.ksef.authToken, config.ksef.nip);
  }

  logger.info('Autoryzacja w KSeF zakończona sukcesem.');

  clientInstance = client;
  return client;
}

const PAGE_SIZE = 100;
// KSeF odrzuca zapytania o metadane z zakresem dat dłuższym niż 3 miesiące
// (exceptionCode 21405: "'dateRange' must not exceed 3 months.") - dzielimy
// więc dłuższe zakresy na kolejne, nienachodzące na siebie okna.
const MAX_QUERY_RANGE_MONTHS = 3;

function addMonthsCapped(date, months, cap) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next < cap ? next : new Date(cap);
}

async function queryInvoicesForSubject(client, subjectType, dateFrom, dateTo) {
  const results = [];
  let chunkStart = new Date(dateFrom);

  while (chunkStart < dateTo) {
    const chunkEnd = addMonthsCapped(chunkStart, MAX_QUERY_RANGE_MONTHS, dateTo);

    logger.info(
      `Zapytanie o faktury (${subjectType}) od ${chunkStart.toISOString().slice(0, 10)} do ${chunkEnd.toISOString().slice(0, 10)}...`,
    );

    let pageOffset = 0;
    for (;;) {
      const page = await client.invoices.queryInvoiceMetadata(
        {
          subjectType,
          dateRange: {
            dateType: 'Issue',
            from: chunkStart.toISOString().slice(0, 10),
            to: chunkEnd.toISOString().slice(0, 10),
          },
        },
        pageOffset,
        PAGE_SIZE,
        'Desc',
      );

      // Znacznik kierunku - potrzebny w index.js do wyboru prefiksu pliku
      // (ksef_koszt_ dla Subject2/nabywca, ksef_przychod_ dla Subject1/sprzedawca).
      for (const invoice of page?.invoices ?? []) {
        results.push({ ...invoice, _subjectType: subjectType });
      }

      if (!page?.hasMore) break;
      pageOffset += PAGE_SIZE;
    }

    // +1 dzień, żeby kolejne okno nie nakładało się na poprzednie (obie
    // granice 'from'/'to' są inkluzywne po stronie API).
    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);
  }

  return results;
}

/**
 * Zwraca listę metadanych faktur wystawionych/otrzymanych w podanym zakresie dat.
 * Automatycznie dzieli zakres na okna <= 3 miesięcy i stronicuje wyniki
 * (ograniczenia API KSeF 2.0).
 * @param {Date} dateFrom
 * @param {Date} dateTo
 * @returns {Promise<Array<{ksefNumber: string, issueDate: string, sellerName?: string, buyerName?: string}>>}
 */
export async function queryInvoices(dateFrom, dateTo) {
  const client = await getKsefClient();

  const subjectTypes =
    config.ksef.subjectRole === 'both'
      ? ['Subject1', 'Subject2']
      : config.ksef.subjectRole === 'seller'
        ? ['Subject1'] // Subject1 = sprzedawca (faktury wystawione)
        : ['Subject2']; // Subject2 = nabywca (faktury kosztowe/otrzymane)

  const results = [];
  for (const subjectType of subjectTypes) {
    results.push(...(await queryInvoicesForSubject(client, subjectType, dateFrom, dateTo)));
  }

  return results;
}

/**
 * Pobiera treść XML pojedynczej faktury po numerze KSeF.
 * @param {string} ksefNumber
 * @returns {Promise<Buffer>}
 */
export async function downloadInvoiceXml(ksefNumber) {
  const client = await getKsefClient();
  // client.invoices.getInvoice() zwraca gotowy string XML (już zdekodowany
  // przez bibliotekę), stąd tylko konwersja do Buffer na potrzeby uploadu.
  const xml = await client.invoices.getInvoice(ksefNumber);
  return Buffer.from(xml, 'utf-8');
}

import { config } from './config.js';
import { logger } from './logger.js';
import { queryInvoices, downloadInvoiceXml } from './ksefClient.js';
import { ensureYearMonthFolder, fileExistsInFolder, uploadFile } from './driveClient.js';
import { parseInvoiceXml } from './invoiceParser.js';
import { renderInvoiceHtml } from './invoiceHtml.js';
import { renderPdfFromHtml } from './pdfRenderer.js';
import { sendMail } from './mailClient.js';
import { registerInvoice } from './invoiceRegister.js';

// Subject1 = sprzedawca (faktury wystawione/przychodowe),
// Subject2 = nabywca (faktury otrzymane/kosztowe) - patrz ksefClient.js.
function directionFor(invoice) {
  return invoice._subjectType === 'Subject1' ? 'przychod' : 'koszt';
}

function buildFilenames(invoice, kierunek) {
  const safeNumber = invoice.ksefNumber.replace(/[^a-zA-Z0-9-]/g, '_');
  const base = `ksef_${kierunek}_${safeNumber}`;
  return { xml: `${base}.xml`, pdf: `${base}.pdf` };
}

// Zaobserwowane w praktyce: pojedyncze żądanie do KSeF/Drive może się
// zawiesić na dobre (bez błędu, bez timeoutu biblioteki) i zablokować całą
// resztę synchronizacji w nieskończoność - także przy cichym uruchomieniu
// z systemd. Ten timeout zamienia taki zwis w błąd dla JEDNEJ faktury,
// żeby pętla mogła iść dalej.
const PER_INVOICE_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Krótka przerwa między fakturami - uprzejmiej wobec API KSeF przy dłuższych
// seriach żądań (np. przy jednorazowym uzupełnianiu zaległości za dłuższy
// okres). Przy zwykłym, codziennym locie (kilka faktur z ostatnich 7 dni)
// praktycznie niezauważalne.
const DELAY_BETWEEN_INVOICES_MS = 300;

// Błąd wysyłki maila (np. wygasły refresh token dla Gmaila) nie powinien
// zmieniać wyniku samej synchronizacji - tylko go zalogować.
async function notify(subject, text) {
  try {
    await sendMail({ to: config.notifyEmail, subject, text });
    logger.info(`Wysłano mail z podsumowaniem do ${config.notifyEmail}.`);
  } catch (err) {
    logger.error(`Nie udało się wysłać maila z podsumowaniem: ${err.message}`);
  }
}

function formatInvoiceLine(entry) {
  const amount = entry.grossAmount ? `${entry.grossAmount} ${entry.currency ?? ''}`.trim() : '';
  return `- [${entry.kierunek}] ${entry.ksefNumber} (${entry.issueDate}) ${entry.counterparty ?? ''} ${amount}`.trim();
}

async function run() {
  const dateTo = new Date();
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - config.lookbackDays);

  logger.info(
    `--- Start synchronizacji KSeF -> Google Drive (zakres: ${dateFrom.toISOString().slice(0, 10)} - ${dateTo.toISOString().slice(0, 10)}) ---`,
  );

  let invoices;
  try {
    invoices = await queryInvoices(dateFrom, dateTo);
  } catch (err) {
    logger.error(`Nie udało się pobrać listy faktur z KSeF: ${err.message}`);
    await notify(
      'ksef-drive-sync: BŁĄD - nie udało się pobrać listy faktur',
      `Zapytanie o faktury do KSeF zakończyło się błędem:\n\n${err.message}\n\nSprawdź log na serwerze (${config.logFile}).`,
    );
    process.exitCode = 1;
    return;
  }

  logger.info(`Znaleziono ${invoices.length} faktur w zadanym zakresie dat.`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let pdfFailed = 0;
  const uploadedList = [];
  const failedList = [];
  const duplicateWarnings = [];

  for (const invoice of invoices) {
    const ksefNumber = invoice.ksefNumber || invoice.ksefReferenceNumber;
    const issueDateStr = invoice.issueDate || invoice.invoiceDate;

    if (!ksefNumber || !issueDateStr) {
      logger.warn(`Pomijam wpis bez numeru KSeF lub daty wystawienia: ${JSON.stringify(invoice)}`);
      failed++;
      failedList.push({ ksefNumber: ksefNumber ?? '(brak numeru)', error: 'brak numeru KSeF lub daty wystawienia' });
      continue;
    }

    const issueDate = new Date(issueDateStr);
    const year = issueDate.getFullYear();
    const month = issueDate.getMonth() + 1;
    const kierunek = directionFor(invoice);
    const { xml: xmlFilename, pdf: pdfFilename } = buildFilenames({ ksefNumber }, kierunek);

    try {
      let wasSkipped = false;

      await withTimeout(
        (async () => {
          const folderId = await ensureYearMonthFolder(year, month);

          // Dedup tylko po XML (dokument źródłowy). Jeśli PDF wcześniej się
          // nie udał, a XML już jest - nie ponawiamy próby PDF automatycznie
          // (uproszczenie; do ręcznej naprawy: usuń XML na Dysku i uruchom
          // ponownie).
          const alreadyThere = await fileExistsInFolder(folderId, xmlFilename);
          if (alreadyThere) {
            logger.info(`Faktura ${ksefNumber} już istnieje na Dysku (${year}/${month}) - pomijam.`);
            wasSkipped = true;
            return;
          }

          const xml = await downloadInvoiceXml(ksefNumber);
          await uploadFile(folderId, xmlFilename, xml, 'application/xml');

          // Parsowane raz, reużywane i przez PDF, i przez rejestr - błąd
          // parsowania nie powinien cofać już udanego wgrania XML (patrz
          // komentarz o ograniczeniu tego podejścia), więc oba dalsze kroki
          // są opcjonalne/nie-fatalne.
          let parsed = null;
          try {
            parsed = parseInvoiceXml(xml);
          } catch (parseErr) {
            logger.error(`Nie udało się sparsować XML faktury ${ksefNumber} (PDF i rejestr pominięte): ${parseErr.message}`);
          }

          if (parsed) {
            try {
              const html = renderInvoiceHtml(parsed, kierunek);
              const pdf = await renderPdfFromHtml(html);
              await uploadFile(folderId, pdfFilename, pdf, 'application/pdf');
            } catch (pdfErr) {
              logger.error(`Nie udało się wygenerować PDF dla faktury ${ksefNumber}: ${pdfErr.message}`);
              pdfFailed++;
            }

            // Rejestr faktur jest opcjonalny (GOOGLE_REGISTER_SHEET_ID) - patrz
            // src/invoiceRegister.js. Sprzedawca = "dostawca" niezależnie od
            // kierunku (dla przychodu to my sami - nieistotne dla dedupu, ale
            // trzyma spójny schemat kolumn).
            if (config.google.registerSheetId) {
              try {
                const sprzedawca = parsed.sprzedawca ?? {};
                const duplicates = await registerInvoice({
                  rok: year,
                  miesiac: month,
                  zrodlo: 'ksef',
                  kierunek,
                  numerFaktury: parsed.numerFaktury,
                  nipDostawcy: sprzedawca.nip,
                  nazwaDostawcy: sprzedawca.nazwa,
                  dataWystawienia: parsed.dataWystawienia,
                  kwotaBrutto: parsed.sumaBrutto,
                  waluta: parsed.waluta,
                  plikNazwa: xmlFilename,
                });
                if (duplicates.length) {
                  duplicateWarnings.push({ ksefNumber, matches: duplicates });
                }
              } catch (regErr) {
                logger.error(`Nie udało się zarejestrować faktury ${ksefNumber} w rejestrze: ${regErr.message}`);
              }
            }
          }
        })(),
        PER_INVOICE_TIMEOUT_MS,
        `Przekroczono limit czasu (${PER_INVOICE_TIMEOUT_MS / 1000}s) - KSeF lub Drive nie odpowiedziały.`,
      );

      if (wasSkipped) {
        skipped++;
      } else {
        uploaded++;
        uploadedList.push({
          ksefNumber,
          kierunek,
          issueDate: issueDateStr,
          grossAmount: invoice.grossAmount,
          currency: invoice.currency,
          counterparty: kierunek === 'przychod' ? invoice.buyer?.name : invoice.seller?.name,
        });
      }
    } catch (err) {
      logger.error(`Błąd przy przetwarzaniu faktury ${ksefNumber}: ${err.message}`);
      failed++;
      failedList.push({ ksefNumber, error: err.message });
    }

    await sleep(DELAY_BETWEEN_INVOICES_MS);
  }

  logger.info(
    `--- Koniec synchronizacji. Wgrano: ${uploaded}, pominięto (duplikaty): ${skipped}, błędy: ${failed}, błędy PDF: ${pdfFailed}. ---`,
  );

  const subject =
    (uploaded > 0
      ? `ksef-drive-sync: ${uploaded} nowych faktur`
      : failed > 0
        ? `ksef-drive-sync: 0 nowych faktur, ${failed} błędów`
        : 'ksef-drive-sync: brak nowych faktur') +
    (duplicateWarnings.length ? ` - ⚠️ ${duplicateWarnings.length} możliwy(ch) duplikat(ów)` : '');

  const bodyParts = [
    `Zakres: ${dateFrom.toISOString().slice(0, 10)} - ${dateTo.toISOString().slice(0, 10)}`,
    `Znaleziono w KSeF: ${invoices.length}`,
    `Wgrano nowych: ${uploaded}`,
    `Pominięto (duplikaty): ${skipped}`,
    `Błędy: ${failed}`,
    `Błędy generowania PDF (XML mimo to wgrany): ${pdfFailed}`,
  ];

  if (uploadedList.length) {
    bodyParts.push('', 'Nowe faktury:', ...uploadedList.map(formatInvoiceLine));
  }
  if (failedList.length) {
    bodyParts.push('', 'Błędy:', ...failedList.map((f) => `- ${f.ksefNumber}: ${f.error}`));
  }
  if (duplicateWarnings.length) {
    bodyParts.push(
      '',
      '⚠️ MOŻLIWE DUPLIKATY (ta sama faktura wygląda na już zarejestrowaną jako ręczny skan lub inna faktura KSeF - sprawdź w rejestrze i na Dysku):',
      ...duplicateWarnings.map(
        (w) => `- ${w.ksefNumber}: pasuje do ${w.matches.map((m) => `${m.zrodlo === 'ksef' ? 'KSeF' : 'skan'} "${m.plikNazwa}"`).join(', ')}`,
      ),
    );
  }

  await notify(subject, bodyParts.join('\n'));

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run()
  .catch((err) => {
    logger.error(`Nieoczekiwany błąd krytyczny: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Porzucone (przekroczone timeoutem) żądanie mogło zostawić otwarty
    // uchwyt sieciowy w tle - bez tego proces mógłby nie zakończyć się sam,
    // co dla jednorazowego zadania systemd (Type=oneshot) oznaczałoby, że
    // usługa nigdy nie przechodzi w stan "zakończona".
    process.exit(process.exitCode ?? 0);
  });

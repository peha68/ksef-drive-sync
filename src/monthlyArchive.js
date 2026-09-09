/**
 * Uruchamiane raz w miesiącu (10. dnia, patrz systemd/ksef-drive-sync-monthly.timer):
 * pakuje wszystkie pliki z folderu <root>/<rok>/<poprzedni miesiąc> (faktury
 * XML/PDF z KSeF + ręczne skany scan_koszt_*) do jednego ZIP-a i wysyła go
 * mailem.
 *
 * Bezpiecznik: dopóki config.accounting.sendToAccounting === false (patrz
 * .env, MONTHLY_ARCHIVE_SEND_TO_ACCOUNTING), mail leci TYLKO na NOTIFY_EMAIL
 * (do testów), niezależnie od tego czy ACCOUNTING_EMAIL jest ustawiony.
 */
import JSZip from 'jszip';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  findYearMonthFolder,
  listFilesInFolder,
  downloadFileContent,
  uploadFile,
  makeFilePublicAndGetLink,
  ensureRootSubfolder,
} from './driveClient.js';
import { sendMail } from './mailClient.js';

// Konserwatywny limit: mail idzie w base64 (~1.37x rozmiaru) i Gmail liczy
// całą wiadomość (razem z nagłówkami i tekstem) do ~25MB. Poniżej tego progu
// zawsze mieścimy się z zapasem.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const ARCHIVE_FOLDER_NAME = '_Archiwa_miesieczne';

function previousMonth(referenceDate) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth(); // 0-based; -1 = poprzedni miesiąc
  const prev = new Date(year, month - 1, 1);
  return { year: prev.getFullYear(), month: prev.getMonth() + 1 };
}

async function buildZip(files) {
  const zip = new JSZip();
  for (const file of files) {
    const content = await downloadFileContent(file.id);
    zip.file(file.name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function recipients() {
  const to = [config.notifyEmail];
  if (config.accounting.sendToAccounting && config.accounting.email) {
    to.push(config.accounting.email);
  }
  return to;
}

async function run() {
  const { year, month } = previousMonth(new Date());
  const monthLabel = `${year}-${String(month).padStart(2, '0')}`;
  const to = recipients();

  logger.info(`--- Start archiwizacji miesięcznej za ${monthLabel} (odbiorcy: ${to.join(', ')}) ---`);

  const folderId = await findYearMonthFolder(year, month);
  const files = folderId ? await listFilesInFolder(folderId) : [];

  if (!files.length) {
    logger.info(`Brak plików za ${monthLabel} - nic do zarchiwizowania.`);
    await sendMail({
      to,
      subject: `ksef-drive-sync: brak danych za ${monthLabel} do zarchiwizowania`,
      text: `Folder ${monthLabel} jest pusty albo nie istnieje - nie wysłano archiwum.`,
    });
    logger.info('--- Koniec archiwizacji miesięcznej (brak danych) ---');
    return;
  }

  logger.info(`Pakuję ${files.length} plików z folderu ${monthLabel}...`);
  const zipBuffer = await buildZip(files);
  const zipFilename = `ksef_archiwum_${monthLabel}.zip`;

  logger.info(`ZIP gotowy: ${zipFilename}, ${zipBuffer.length} bajtów.`);

  const testModeNote = config.accounting.sendToAccounting
    ? ''
    : '\n\nUWAGA: MONTHLY_ARCHIVE_SEND_TO_ACCOUNTING=false - to jest tryb testowy, mail nie poszedł do księgowości.';

  if (zipBuffer.length <= MAX_ATTACHMENT_BYTES) {
    await sendMail({
      to,
      subject: `ksef-drive-sync: archiwum faktur za ${monthLabel}`,
      text: `W załączniku archiwum ZIP z fakturami/skanami za ${monthLabel} (${files.length} plików).${testModeNote}`,
      attachments: [{ filename: zipFilename, mimeType: 'application/zip', content: zipBuffer }],
    });
    logger.info(`Wysłano archiwum jako załącznik do: ${to.join(', ')}.`);
  } else {
    // Za duże na załącznik - wgrywamy na Dysk (osobny folder, żeby nie
    // trafiło przy okazji do kolejnego archiwum) i wysyłamy link zamiast pliku.
    const archiveFolderId = await ensureRootSubfolder(ARCHIVE_FOLDER_NAME);
    const fileId = await uploadFile(archiveFolderId, zipFilename, zipBuffer, 'application/zip');
    const link = await makeFilePublicAndGetLink(fileId);

    await sendMail({
      to,
      subject: `ksef-drive-sync: archiwum faktur za ${monthLabel} (link, plik za duży na załącznik)`,
      text:
        `Archiwum ZIP za ${monthLabel} (${files.length} plików, ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB) ` +
        `jest za duże na załącznik e-mail. Pobierz je stąd:\n\n${link}${testModeNote}`,
    });
    logger.info(`Wysłano link do archiwum (plik za duży na załącznik) do: ${to.join(', ')}.`);
  }

  logger.info(`--- Koniec archiwizacji miesięcznej za ${monthLabel} ---`);
}

run()
  .catch((err) => {
    logger.error(`Nieoczekiwany błąd krytyczny (archiwizacja miesięczna): ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });

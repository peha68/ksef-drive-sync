/**
 * Wymusza ponowne wygenerowanie PDF-ów dla WSZYSTKICH faktur XML w danym
 * roku/miesiącu, NADPISUJĄC istniejące pliki (w odróżnieniu od
 * backfill-pdfs.js, które uzupełnia tylko brakujące). Do użycia po zmianie
 * w invoiceParser.js/invoiceHtml.js, która wpływa na wygląd już
 * wygenerowanych PDF-ów (np. naprawa pustej kolumny "Wartość brutto" -
 * 2026-09-17).
 *
 * Uruchom: node scripts/regenerate-month-pdfs.js <rok> <miesiąc>
 * np.:     node scripts/regenerate-month-pdfs.js 2026 09
 * (wymaga wkhtmltopdf zainstalowanego lokalnie na maszynie, na której się
 * to uruchamia - patrz README.md sekcja "Generowanie PDF")
 */
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import {
  listSubfolders,
  listFilesInFolder,
  downloadFileContent,
  uploadFile,
  updateFileContent,
} from '../src/driveClient.js';
import { parseInvoiceXml } from '../src/invoiceParser.js';
import { renderInvoiceHtml } from '../src/invoiceHtml.js';
import { renderPdfFromHtml } from '../src/pdfRenderer.js';

const XML_NAME_RE = /^ksef_(koszt|przychod)_(.+)\.xml$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findMonthFolder(year, month) {
  const yearFolders = await listSubfolders(config.google.rootFolderId);
  const yearFolder = yearFolders.find((f) => f.name === String(year));
  if (!yearFolder) return null;

  const monthFolders = await listSubfolders(yearFolder.id);
  return monthFolders.find((f) => f.name === String(month).padStart(2, '0')) ?? null;
}

async function run() {
  const [, , yearArg, monthArg] = process.argv;
  if (!yearArg || !monthArg) {
    logger.error('Użycie: node scripts/regenerate-month-pdfs.js <rok> <miesiąc>');
    process.exitCode = 1;
    return;
  }

  logger.info(`--- Start wymuszonej regeneracji PDF-ów dla ${yearArg}/${monthArg} ---`);

  const monthFolder = await findMonthFolder(yearArg, monthArg);
  if (!monthFolder) {
    logger.error(`Nie znaleziono folderu ${yearArg}/${monthArg} na Dysku.`);
    process.exitCode = 1;
    return;
  }

  const files = await listFilesInFolder(monthFolder.id);
  const namesInFolder = new Map(files.map((f) => [f.name, f]));
  const xmlFiles = files.filter((f) => XML_NAME_RE.test(f.name));

  logger.info(`Znaleziono ${xmlFiles.length} faktur XML w ${yearArg}/${monthArg}.`);

  let done = 0;
  let failed = 0;

  for (const xmlFile of xmlFiles) {
    const match = xmlFile.name.match(XML_NAME_RE);
    const [, kierunek, base] = match;
    const pdfName = `ksef_${kierunek}_${base}.pdf`;

    try {
      const xml = await downloadFileContent(xmlFile.id);
      const parsed = parseInvoiceXml(xml);
      const html = renderInvoiceHtml(parsed, kierunek);
      const pdf = await renderPdfFromHtml(html);

      const existingPdf = namesInFolder.get(pdfName);
      if (existingPdf) {
        await updateFileContent(existingPdf.id, pdf, 'application/pdf');
        logger.info(`[${yearArg}/${monthArg}] Nadpisano ${pdfName}.`);
      } else {
        await uploadFile(monthFolder.id, pdfName, pdf, 'application/pdf');
        logger.info(`[${yearArg}/${monthArg}] Utworzono brakujący ${pdfName}.`);
      }
      done++;
    } catch (err) {
      logger.error(`[${yearArg}/${monthArg}] Błąd dla ${xmlFile.name}: ${err.message}`);
      failed++;
    }

    await sleep(200);
  }

  logger.info(`--- Koniec. Zregenerowano: ${done}, błędy: ${failed}. ---`);
}

run()
  .catch((err) => {
    logger.error(`Nieoczekiwany błąd krytyczny (regenerate-month-pdfs): ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });

/**
 * Narzędzie porządkowe: przechodzi po wszystkich folderach <rok>/<miesiąc>
 * na Dysku, znajduje faktury XML (ksef_koszt_*.xml / ksef_przychod_*.xml),
 * które nie mają obok siebie odpowiadającego PDF-a (np. bo w chwili
 * pobierania nie było zainstalowanego wkhtmltopdf - patrz komentarz w
 * src/index.js o tym ograniczeniu dedupu), i dogenerowuje brakujące PDF-y
 * na podstawie XML-a już leżącego na Dysku - bez ponownego odpytywania KSeF.
 *
 * Uruchom: npm run backfill-pdfs (wymaga wkhtmltopdf zainstalowanego lokalnie,
 * patrz README.md sekcja "Generowanie PDF").
 */
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import {
  listSubfolders,
  listFilesInFolder,
  downloadFileContent,
  uploadFile,
} from '../src/driveClient.js';
import { parseInvoiceXml } from '../src/invoiceParser.js';
import { renderInvoiceHtml } from '../src/invoiceHtml.js';
import { renderPdfFromHtml } from '../src/pdfRenderer.js';

const XML_NAME_RE = /^ksef_(koszt|przychod)_(.+)\.xml$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findMissingPdfs() {
  const missing = []; // {folderId, folderLabel, xmlFile, kierunek, pdfName}

  const yearFolders = (await listSubfolders(config.google.rootFolderId)).filter((f) => /^\d{4}$/.test(f.name));

  for (const yearFolder of yearFolders) {
    const monthFolders = (await listSubfolders(yearFolder.id)).filter((f) => /^\d{2}$/.test(f.name));

    for (const monthFolder of monthFolders) {
      const files = await listFilesInFolder(monthFolder.id);
      const namesInFolder = new Set(files.map((f) => f.name));

      for (const file of files) {
        const match = file.name.match(XML_NAME_RE);
        if (!match) continue;

        const [, kierunek, base] = match;
        const pdfName = `ksef_${kierunek}_${base}.pdf`;

        if (!namesInFolder.has(pdfName)) {
          missing.push({
            folderId: monthFolder.id,
            folderLabel: `${yearFolder.name}/${monthFolder.name}`,
            xmlFile: file,
            kierunek,
            pdfName,
          });
        }
      }
    }
  }

  return missing;
}

async function run() {
  logger.info('--- Start uzupełniania brakujących PDF-ów ---');

  const missing = await findMissingPdfs();
  logger.info(`Znaleziono ${missing.length} faktur XML bez odpowiadającego PDF-a.`);

  let done = 0;
  let failed = 0;

  for (const item of missing) {
    try {
      const xml = await downloadFileContent(item.xmlFile.id);
      const parsed = parseInvoiceXml(xml);
      const html = renderInvoiceHtml(parsed, item.kierunek);
      const pdf = await renderPdfFromHtml(html);
      await uploadFile(item.folderId, item.pdfName, pdf, 'application/pdf');
      logger.info(`[${item.folderLabel}] Wygenerowano ${item.pdfName}.`);
      done++;
    } catch (err) {
      logger.error(`[${item.folderLabel}] Błąd dla ${item.xmlFile.name}: ${err.message}`);
      failed++;
    }

    await sleep(200);
  }

  logger.info(`--- Koniec. Wygenerowano: ${done}, błędy: ${failed}. ---`);
}

run()
  .catch((err) => {
    logger.error(`Nieoczekiwany błąd krytyczny (backfill-pdfs): ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });

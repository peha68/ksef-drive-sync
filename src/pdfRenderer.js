/**
 * Renderowanie HTML -> PDF przez zewnętrzny binarny `wkhtmltopdf`
 * (apt install wkhtmltopdf na Debianie). Wybrany zamiast Puppeteer/headless
 * Chromium, żeby nie ciągnąć ~300MB zależności do prostego, statycznego
 * layoutu faktury.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function runWkhtmltopdf(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('wkhtmltopdf', args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'Nie znaleziono polecenia "wkhtmltopdf". Zainstaluj je: sudo apt install wkhtmltopdf ' +
              '(patrz README.md, sekcja o generowaniu PDF).',
          ),
        );
      } else {
        reject(err);
      }
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`wkhtmltopdf zakończył się kodem ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/**
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
export async function renderPdfFromHtml(html) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ksef-pdf-'));
  const htmlPath = path.join(dir, 'invoice.html');
  const pdfPath = path.join(dir, 'invoice.pdf');

  try {
    await writeFile(htmlPath, html, 'utf-8');
    // --quiet + brak sieci (--disable-external-links nie jest konieczne, HTML
    // jest w pełni lokalny/statyczny, bez zasobów zewnętrznych).
    await runWkhtmltopdf(['--quiet', '--encoding', 'utf-8', htmlPath, pdfPath]);
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

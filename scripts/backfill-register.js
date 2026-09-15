/**
 * Jednorazowe (albo okazjonalne) narzędzie porządkowe: przechodzi po
 * wszystkich folderach <rok>/<miesiac> na Dysku i:
 *  - dla każdego pliku `ksef_*.xml` jeszcze nie obecnego w rejestrze - pobiera
 *    go, parsuje (invoiceParser.js) i dopisuje do rejestru (z automatycznym
 *    sprawdzeniem duplikatu),
 *  - dla każdego pliku `scan_*` jeszcze nie obecnego w rejestrze - NIE da się
 *    automatycznie wyciągnąć numeru/NIP-u/kwoty ze zdjęcia, więc tylko
 *    wypisuje gotowy szkielet komendy `register-scan.js` do ręcznego
 *    uzupełnienia (numer/NIP/kwota) i uruchomienia.
 *
 * Używane raz, żeby uzupełnić rejestr o faktury wgrane PRZED wdrożeniem tej
 * funkcji - normalny sync (src/index.js) rejestruje nowe faktury z KSeF na
 * bieżąco, więc po jednorazowym backfillu ten skrypt jest potrzebny tylko
 * gdyby ktoś ręcznie wgrał pliki z pominięciem normalnego flow.
 *
 * Użycie: node scripts/backfill-register.js [rok]   (bez roku = wszystkie lata)
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { listSubfolders, listFilesInFolder, downloadFileContent } from '../src/driveClient.js';
import { parseInvoiceXml } from '../src/invoiceParser.js';
import { registerInvoice, getAllRegisterRows } from '../src/invoiceRegister.js';

const onlyYear = process.argv[2] ? Number(process.argv[2]) : null;

function directionFromFilename(name) {
  if (name.startsWith('ksef_koszt_') || name.startsWith('scan_koszt_')) return 'koszt';
  if (name.startsWith('ksef_przychod_') || name.startsWith('scan_przychod_')) return 'przychod';
  return null;
}

const existingRows = await getAllRegisterRows();
const alreadyRegistered = new Set(existingRows.map((r) => `${r.zrodlo}:${r.plikNazwa}`));

let ksefRegistered = 0;
let ksefSkipped = 0;
let scansToDo = [];

const yearFolders = await listSubfolders(config.google.rootFolderId);
for (const yearFolder of yearFolders) {
  const year = Number(yearFolder.name);
  if (!Number.isInteger(year) || (onlyYear && year !== onlyYear)) continue;

  const monthFolders = await listSubfolders(yearFolder.id);
  for (const monthFolder of monthFolders) {
    const month = Number(monthFolder.name);
    if (!Number.isInteger(month)) continue;

    const files = await listFilesInFolder(monthFolder.id);
    for (const file of files) {
      const kierunek = directionFromFilename(file.name);
      if (!kierunek) continue; // np. ksef_*.pdf (odpowiadający .xml już obsłużony) albo nierozpoznana nazwa

      if (file.name.endsWith('.xml') && file.name.startsWith('ksef_')) {
        if (alreadyRegistered.has(`ksef:${file.name}`)) {
          ksefSkipped++;
          continue;
        }
        try {
          const xml = await downloadFileContent(file.id);
          const parsed = parseInvoiceXml(xml);
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
            plikNazwa: file.name,
          });
          ksefRegistered++;
          if (duplicates.length) {
            console.log(`⚠️  ${file.name} (${year}/${String(month).padStart(2, '0')}) - MOŻLIWY DUPLIKAT z: ${duplicates.map((d) => d.plikNazwa).join(', ')}`);
          }
        } catch (err) {
          console.error(`Błąd przy ${file.name}: ${err.message}`);
        }
      } else if (file.name.startsWith('scan_')) {
        if (alreadyRegistered.has(`scan:${file.name}`)) continue;
        scansToDo.push({ year, month, kierunek, name: file.name });
      }
    }
  }
}

console.log(`\nFaktury z KSeF zarejestrowane: ${ksefRegistered}, pominięte (już w rejestrze): ${ksefSkipped}.`);

if (scansToDo.length) {
  console.log(`\n${scansToDo.length} skan(ów) NIE jest jeszcze w rejestrze - uzupełnij numer/NIP/kwotę ręcznie i uruchom (podejrzyj plik na Dysku, żeby je odczytać):\n`);
  for (const s of scansToDo) {
    console.log(
      `node scripts/register-scan.js ${s.year} ${String(s.month).padStart(2, '0')} ${s.kierunek} ${s.name} <numerFaktury> <nipDostawcy> <kwotaBrutto>`,
    );
  }
} else {
  console.log('Wszystkie skany są już w rejestrze.');
}

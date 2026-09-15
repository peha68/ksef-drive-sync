/**
 * Rejestr faktur (Google Sheet) - jeden wiersz na fakturę, niezależnie czy
 * pochodzi z KSeF (automatycznie, patrz index.js) czy jest ręcznym skanem
 * (scripts/register-scan.js). Cel: wykrywać sytuację, w której ta sama
 * faktura istnieje dwa razy na Dysku - raz jako plik z KSeF, raz jako ręczne
 * zdjęcie/skan tego samego dokumentu (np. dostawca wysłał PDF mailem ZANIM
 * faktura trafiła do KSeF, albo ktoś sfotografował paragon, który okazał się
 * mieć też odpowiednik w KSeF).
 *
 * Dopasowanie duplikatu = dokładna zgodność trójki (numer faktury, NIP
 * dostawcy, kwota brutto) - dokładnie tak, jak ustalone z użytkownikiem
 * (2026-09-15), nie żadna rozmyta heurystyka po dacie/nazwie. Świadomie: bez
 * kompletu tych trzech pól wpis NIE jest porównywany z niczym (patrz
 * `hasCompleteKey`) - lepiej brak wykrycia niż fałszywy alarm.
 */
import { config } from './config.js';
import { createSpreadsheet, getValues, appendRow, updateCell } from './sheetsClient.js';
import { logger } from './logger.js';

export const SHEET_TITLE = 'Faktury';
export const HEADERS = [
  'rok',
  'miesiac',
  'zrodlo',
  'kierunek',
  'numerFaktury',
  'nipDostawcy',
  'nazwaDostawcy',
  'dataWystawienia',
  'kwotaBrutto',
  'waluta',
  'plikNazwa',
  'dataDodania',
  'duplikat',
];
const LAST_COLUMN = 'M'; // musi odpowiadać długości HEADERS

export async function createRegisterSheet() {
  return createSpreadsheet('Rejestr faktur - ksef-drive-sync', SHEET_TITLE, HEADERS);
}

function normalizeNumer(s) {
  return (s || '').toString().trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeNip(s) {
  return (s || '').toString().replace(/\D/g, '');
}

function normalizeKwota(s) {
  const n = parseFloat((s || '').toString().replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null; // grosze - porównanie bez błędów zmiennoprzecinkowych
}

function hasCompleteKey(entry) {
  return Boolean(normalizeNumer(entry.numerFaktury) && normalizeNip(entry.nipDostawcy) && normalizeKwota(entry.kwotaBrutto) !== null);
}

function rowToRecord(row, rowNumber) {
  const [rok, miesiac, zrodlo, kierunek, numerFaktury, nipDostawcy, nazwaDostawcy, dataWystawienia, kwotaBrutto, waluta, plikNazwa, dataDodania, duplikat] = row;
  return { rowNumber, rok, miesiac, zrodlo, kierunek, numerFaktury, nipDostawcy, nazwaDostawcy, dataWystawienia, kwotaBrutto, waluta, plikNazwa, dataDodania, duplikat };
}

/**
 * Zwraca wszystkie wiersze rejestru jako obiekty, z `rowNumber` (1-indeksowany,
 * licząc nagłówek jako wiersz 1) - potrzebny do późniejszego updateCell().
 */
export async function getAllRegisterRows() {
  const spreadsheetId = requireSheetId();
  const values = await getValues(spreadsheetId, SHEET_TITLE, LAST_COLUMN);
  return values.map((row, i) => rowToRecord(row, i + 2));
}

/**
 * Wśród już zarejestrowanych wierszy znajduje te, które dokładnie zgadzają
 * się po (numerFaktury, nipDostawcy, kwotaBrutto) z podanym wpisem. Wpisy z
 * niekompletnym kluczem (brak numeru/NIP-u/kwoty po którejkolwiek stronie)
 * nigdy nie są dopasowywane.
 */
export function findMatchingRows(existingRows, entry) {
  if (!hasCompleteKey(entry)) return [];

  const numer = normalizeNumer(entry.numerFaktury);
  const nip = normalizeNip(entry.nipDostawcy);
  const kwota = normalizeKwota(entry.kwotaBrutto);

  return existingRows.filter((r) => {
    if (!hasCompleteKey(r)) return false;
    return normalizeNumer(r.numerFaktury) === numer && normalizeNip(r.nipDostawcy) === nip && normalizeKwota(r.kwotaBrutto) === kwota;
  });
}

function requireSheetId() {
  if (!config.google.registerSheetId) {
    throw new Error(
      'Brak GOOGLE_REGISTER_SHEET_ID w .env - uruchom najpierw `npm run setup-register-sheet` (jednorazowo).',
    );
  }
  return config.google.registerSheetId;
}

function describeRow(r) {
  return `${r.zrodlo === 'ksef' ? 'KSeF' : 'skan'} "${r.plikNazwa}" (${r.rok}/${r.miesiac}, wiersz ${r.rowNumber})`;
}

/**
 * Dopisuje fakturę do rejestru i sprawdza ją względem już istniejących
 * wpisów. Jeśli znajdzie dopasowanie(a) - oznacza duplikat W OBIE STRONY
 * (kolumna "duplikat" w nowym wierszu ORAZ we wszystkich dopasowanych
 * wierszach, żeby ostrzeżenie było widoczne niezależnie od tego, który
 * wiersz ktoś otworzy jako pierwszy).
 *
 * @param {{rok:number|string, miesiac:number|string, zrodlo:'ksef'|'scan', kierunek:'koszt'|'przychod', numerFaktury:string, nipDostawcy:string, nazwaDostawcy?:string, dataWystawienia?:string, kwotaBrutto:string|number, waluta?:string, plikNazwa:string}} entry
 * @returns {Promise<Array>} lista dopasowanych istniejących wierszy (pusta, jeśli brak duplikatu)
 */
export async function registerInvoice(entry) {
  const spreadsheetId = requireSheetId();
  const existingRows = await getAllRegisterRows();
  const duplicates = findMatchingRows(existingRows, entry);

  const miesiacPadded = String(entry.miesiac).padStart(2, '0');
  const dataDodania = new Date().toISOString().slice(0, 10);
  const nowyOpis = duplicates.length
    ? `MOŻLIWY DUPLIKAT: ${duplicates.map(describeRow).join('; ')}`
    : '';

  const row = [
    entry.rok,
    miesiacPadded,
    entry.zrodlo,
    entry.kierunek,
    entry.numerFaktury || '',
    entry.nipDostawcy || '',
    entry.nazwaDostawcy || '',
    entry.dataWystawienia || '',
    entry.kwotaBrutto ?? '',
    entry.waluta || 'PLN',
    entry.plikNazwa,
    dataDodania,
    nowyOpis,
  ];

  await appendRow(spreadsheetId, SHEET_TITLE, row);

  if (duplicates.length) {
    logger.warn(
      `Możliwy duplikat faktury ${entry.numerFaktury} (NIP ${entry.nipDostawcy}, ${entry.kwotaBrutto}): pasuje do ${duplicates.map(describeRow).join('; ')}`,
    );
    // Oznacz też stronę istniejącą - nowy plik jeszcze nie ma numeru wiersza,
    // więc opis odwrotny jest ogólny (bez wskazania konkretnego wiersza nowego wpisu).
    for (const d of duplicates) {
      const existingOpis = d.duplikat
        ? `${d.duplikat}; MOŻLIWY DUPLIKAT: ${entry.zrodlo === 'ksef' ? 'KSeF' : 'skan'} "${entry.plikNazwa}" (${entry.rok}/${miesiacPadded})`
        : `MOŻLIWY DUPLIKAT: ${entry.zrodlo === 'ksef' ? 'KSeF' : 'skan'} "${entry.plikNazwa}" (${entry.rok}/${miesiacPadded})`;
      await updateCell(spreadsheetId, SHEET_TITLE, `M${d.rowNumber}`, existingOpis);
    }
  }

  return duplicates;
}

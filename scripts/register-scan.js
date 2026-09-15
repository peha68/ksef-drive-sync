/**
 * Rejestruje ręcznie dodany skan (scan_koszt_... lub scan_przychod_..., patrz README
 * sekcja 5a) w rejestrze faktur i od razu sprawdza go pod kątem duplikatu z
 * fakturą z KSeF (albo z innym skanem) po (numer faktury, NIP dostawcy,
 * kwota brutto).
 *
 * Użycie:
 *   node scripts/register-scan.js <rok> <miesiac> <koszt|przychod> <plikNazwa> <numerFaktury> <nipDostawcy> <kwotaBrutto> [nazwaDostawcy] [dataWystawienia RRRR-MM-DD] [waluta]
 *
 * Przykład:
 *   node scripts/register-scan.js 2026 09 koszt scan_koszt_paliwo_orlen.jpg FV/123/2026 5261234567 214.50 "Orlen S.A." 2026-09-12
 *
 * `plikNazwa` musi dokładnie odpowiadać nazwie pliku wgranego na Dysk do
 * folderu <rok>/<miesiac> (sprawdzane przed zapisem - ostrzeżenie, nie blok,
 * gdyby plik był dodany minutę wcześniej i indeks Dysku jeszcze się nie
 * zaktualizował).
 */
import 'dotenv/config';
import { findYearMonthFolder, fileExistsInFolder } from '../src/driveClient.js';
import { registerInvoice } from '../src/invoiceRegister.js';

const [rok, miesiac, kierunek, plikNazwa, numerFaktury, nipDostawcy, kwotaBrutto, nazwaDostawcy, dataWystawienia, waluta] = process.argv.slice(2);

function usage(msg) {
  if (msg) console.error(`Błąd: ${msg}\n`);
  console.error(
    'Użycie: node scripts/register-scan.js <rok> <miesiac> <koszt|przychod> <plikNazwa> <numerFaktury> <nipDostawcy> <kwotaBrutto> [nazwaDostawcy] [dataWystawienia] [waluta]',
  );
  process.exit(1);
}

if (!rok || !miesiac || !kierunek || !plikNazwa || !numerFaktury || !nipDostawcy || !kwotaBrutto) {
  usage('brak wymaganych argumentów');
}
if (!['koszt', 'przychod'].includes(kierunek)) {
  usage(`kierunek musi być "koszt" albo "przychod", podano "${kierunek}"`);
}
if (!/^\d{10}$/.test(nipDostawcy.replace(/\D/g, ''))) {
  usage(`NIP powinien mieć 10 cyfr, podano "${nipDostawcy}"`);
}

const folderId = await findYearMonthFolder(Number(rok), Number(miesiac));
if (!folderId) {
  console.warn(`⚠️  Folder ${rok}/${String(miesiac).padStart(2, '0')} jeszcze nie istnieje na Dysku - upewnij się, że plik faktycznie tam jest.`);
} else {
  const exists = await fileExistsInFolder(folderId, plikNazwa);
  if (!exists) {
    console.warn(`⚠️  Nie znalazłem pliku "${plikNazwa}" w folderze ${rok}/${String(miesiac).padStart(2, '0')} na Dysku - sprawdź nazwę (rejestruję mimo to).`);
  }
}

const duplicates = await registerInvoice({
  rok: Number(rok),
  miesiac: Number(miesiac),
  zrodlo: 'scan',
  kierunek,
  numerFaktury,
  nipDostawcy,
  nazwaDostawcy: nazwaDostawcy || '',
  dataWystawienia: dataWystawienia || '',
  kwotaBrutto,
  waluta: waluta || 'PLN',
  plikNazwa,
});

if (duplicates.length) {
  console.log(`\n⚠️  MOŻLIWY DUPLIKAT - ta faktura (numer + NIP + kwota) pasuje do ${duplicates.length} już zarejestrowanej pozycji:`);
  for (const d of duplicates) {
    console.log(`   - ${d.zrodlo === 'ksef' ? 'KSeF' : 'skan'} "${d.plikNazwa}" (${d.rok}/${d.miesiac}, wiersz ${d.rowNumber})`);
  }
  console.log('\nSprawdź ręcznie w arkuszu, czy to naprawdę ta sama faktura - jeśli tak, usuń jedną z kopii z Dysku.');
} else {
  console.log('\n✅ Zarejestrowano, brak dopasowania w rejestrze - nie wygląda na duplikat.');
}

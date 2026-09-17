/**
 * Parser XML faktury FA(3) (KSeF 2.0) do prostego obiektu używanego przy
 * renderowaniu wizualizacji PDF.
 *
 * WAŻNE: Ministerstwo Finansów NIE publikuje oficjalnego szablonu/XSLT do
 * wizualizacji FA(3) (sprawdzone na ksef.podatki.gov.pl - w przeciwieństwie
 * do starszego KSeF 1.0/FA(2), gdzie taki szablon istniał; jest za to
 * nieoficjalna, budowana z GitHuba biblioteka CIRFMF/ksef-pdf-generator,
 * ale działa tylko po stronie przeglądarki i nie da się jej łatwo użyć w
 * naszym headless skrypcie na serwerze). Ten parser i layout PDF (patrz
 * invoiceHtml.js) są własnej roboty, zweryfikowane względem 79 realnych
 * faktur z produkcji (różni wystawcy, różne typy) - nie są urzędowym wzorem,
 * ale pokrywają pola występujące w >10% realnych przypadków. Rzadsze pola
 * (WZ, Zamowienie, WarunkiTransakcji, częściowe płatności, kody
 * PKWiU/CN/GTIN) świadomie pominięte.
 */
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // WAŻNE: bez tego parser konwertuje długie cyfrowe wartości (numer
  // rachunku bankowego, NIP, REGON...) na liczby zmiennoprzecinkowe, tracąc
  // precyzję (np. 57114... -> 5.71...e+25). Wszystko musi zostać stringiem.
  parseTagValue: false,
  parseAttributeValue: false,
  // WAŻNE: część wystawców generuje FA(3) z jawnym prefiksem namespace
  // (np. <tns:Fa> zamiast <Fa>) zamiast domyślnego namespace. Bez tej opcji
  // parser po cichu (bez błędu!) zwracał pustą fakturę dla ~10% realnych
  // faktur w produkcji - wykryte przy analizie 79 pobranych plików.
  removeNSPrefix: true,
});

// Słowniki kodów ze schematu FA(3) - potwierdzone w dwóch niezależnych
// źródłach (analiza XSD), nie zgadywane.
const FORMA_PLATNOSCI = {
  1: 'gotówka',
  2: 'karta',
  3: 'bon',
  4: 'czek',
  5: 'kredyt',
  6: 'przelew',
  7: 'mobilna',
};

const ROLA_PODMIOTU3 = {
  1: 'Faktor',
  2: 'Odbiorca',
  3: 'Podmiot pierwotny',
  4: 'Dodatkowy nabywca',
  5: 'Wystawca faktury (w imieniu sprzedawcy)',
  6: 'Dokonujący płatności',
  7: 'JST - wystawca',
  8: 'JST - odbiorca',
  9: 'Członek grupy VAT - wystawca',
  10: 'Członek grupy VAT - odbiorca',
  11: 'Pracownik',
};

function decodeOrRaw(dict, code) {
  if (!code) return '';
  return dict[code] ?? code; // nieznany/przyszły kod - pokaż surowo zamiast ukryć
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return value['#text'] ?? '';
  return String(value);
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const t = text(v);
    if (t) return t;
  }
  return '';
}

// P_12 (stawka VAT) to nie zawsze liczba - TStawkaPodatku ze schematu FA(3)
// dopuszcza też kody bez VAT: "0 KR"/"0 WDT"/"0 EX" (stawka 0%), "zw"
// (zwolnione), "oo" (odwrotne obciążenie), "np I"/"np II" (niepodlegające) -
// we wszystkich tych przypadkach na fakturze nie doliczono VAT, więc brutto
// = netto. Zwraca null (nie 0!) dla naprawdę nierozpoznanego kodu, żeby
// wywołujący mógł zrezygnować z wyliczenia zamiast zgadywać.
function vatRatePercent(stawkaVat) {
  const s = text(stawkaVat).trim();
  if (!s) return null;
  if (/^\d+([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  if (['0 KR', '0 WDT', '0 EX', 'zw', 'oo', 'np I', 'np II'].includes(s)) return 0;
  return null;
}

// P_11A ("Wartość sprzedaży brutto") to pole ze schematu FA(3) opisane
// wyłącznie dla szczególnego przypadku z art. 106e ust. 7-8 ustawy - w
// praktyce PRAWIE ŻADEN wystawca go nie wypełnia (potwierdzone na realnych
// fakturach z mOrganizera/CashDirector), więc kolumna "Wartość brutto" była
// pusta dla każdej pozycji niemal zawsze - niezauważalne przy jednej
// pozycji (suma "Do zapłaty" pod spodem sprawiała wrażenie, że to ta sama
// wartość), rażące przy kilku. Licz brutto samodzielnie z tego, co faktura
// faktycznie podaje: P_11A jeśli jest (najbardziej autorytatywne), inaczej
// netto+VAT z P_11Vat jeśli jest, inaczej netto*(1+stawka/100) gdy stawka
// jest liczbą lub jednym z bezpodatkowych kodów. Jeśli nic z tego się nie
// da policzyć - pusta komórka, nie zgadywanie.
function computeLineBrutto(w) {
  const explicit = text(w.P_11A);
  if (explicit) return explicit;

  const netto = Number(text(w.P_11).replace(',', '.'));
  if (!Number.isFinite(netto)) return '';

  const vatKwota = text(w.P_11Vat);
  if (vatKwota) {
    const vat = Number(vatKwota.replace(',', '.'));
    if (Number.isFinite(vat)) return (netto + vat).toFixed(2);
  }

  const rate = vatRatePercent(w.P_12);
  if (rate !== null) return (netto * (1 + rate / 100)).toFixed(2);

  return '';
}

function parseParty(podmiot) {
  if (!podmiot) return null;
  const dane = podmiot.DaneIdentyfikacyjne ?? {};
  const adres = podmiot.Adres ?? {};
  return {
    nip: text(dane.NIP),
    nazwa: text(dane.Nazwa ?? dane.ImieNazwisko),
    adres: [text(adres.AdresL1), text(adres.AdresL2)].filter(Boolean).join(', '),
    krajKod: text(adres.KodKraju),
  };
}

function parsePlatnosc(platnosc) {
  if (!platnosc) return null;
  const rachunki = asArray(platnosc.RachunekBankowy);
  const rachunek = rachunki[0]; // przy wielu rachunkach pokazujemy tylko pierwszy (prosty layout)

  return {
    // PlatnoscInna/OpisPlatnosci pojawiają się w XML tylko gdy forma
    // płatności nie pasuje do żadnego standardowego kodu (patrz FORMA_PLATNOSCI).
    formaPlatnosci: firstNonEmpty(platnosc.OpisPlatnosci, platnosc.PlatnoscInna) ||
      decodeOrRaw(FORMA_PLATNOSCI, text(platnosc.FormaPlatnosci)),
    terminPlatnosci: text(platnosc.TerminPlatnosci?.Termin),
    zaplacono: text(platnosc.Zaplacono) === '1' || text(platnosc.Zaplacono) === 'true',
    dataZaplaty: text(platnosc.DataZaplaty),
    rachunekBankowy: rachunek
      ? {
          numer: text(rachunek.NrRB),
          bank: text(rachunek.NazwaBanku),
          swift: text(rachunek.SWIFT),
        }
      : null,
  };
}

function parseKorekta(fa) {
  const dane = fa.DaneFaKorygowanej;
  if (!dane) return null;
  return {
    numerFaktury: text(dane.NrFaKorygowanej),
    dataWystawienia: text(dane.DataWystFaKorygowanej),
    przyczyna: text(fa.PrzyczynaKorekty),
  };
}

/**
 * @param {Buffer|string} xml
 */
export function parseInvoiceXml(xml) {
  const raw = typeof xml === 'string' ? xml : xml.toString('utf-8');
  const doc = parser.parse(raw);
  const faktura = doc.Faktura ?? {};
  const fa = faktura.Fa ?? {};

  const pozycje = asArray(fa.FaWiersz).map((w) => ({
    lp: text(w.NrWierszaFa),
    nazwa: text(w.P_7),
    jednostka: text(w.P_8A),
    ilosc: text(w.P_8B),
    cenaNetto: firstNonEmpty(w.P_9A, w.P_9B),
    wartoscNetto: text(w.P_11),
    wartoscBrutto: computeLineBrutto(w),
    stawkaVat: text(w.P_12),
  }));

  const dodatkowyOpis = asArray(fa.DodatkowyOpis)
    .map((d) => ({ klucz: text(d.Klucz), wartosc: text(d.Wartosc) }))
    .filter((d) => d.klucz || d.wartosc);

  const obciazenia = asArray(fa.Rozliczenie?.Obciazenia).map((o) => ({
    kwota: text(o.Kwota),
    powod: text(o.Powod),
  }));

  return {
    numerFaktury: text(fa.P_2),
    dataWystawienia: text(fa.P_1),
    dataDostawy: text(fa.P_6),
    okresOd: text(fa.OkresFa?.P_6_Od),
    okresDo: text(fa.OkresFa?.P_6_Do),
    miejsceWystawienia: text(fa.P_1M),
    waluta: text(fa.KodWaluty) || 'PLN',
    rodzajFaktury: text(fa.RodzajFaktury),
    sprzedawca: parseParty(faktura.Podmiot1),
    nabywca: parseParty(faktura.Podmiot2),
    trzeciPodmiot: faktura.Podmiot3
      ? { ...parseParty(faktura.Podmiot3), rola: decodeOrRaw(ROLA_PODMIOTU3, text(faktura.Podmiot3.Rola)) }
      : null,
    pozycje,
    // Rozliczenie.DoZaplaty jest dokładniejsze niż P_15, gdy są dodatkowe
    // obciążenia pozą-VAT-owe (np. opłaty niepodlegające VAT) - patrz
    // Rozliczenie.Obciazenia niżej.
    sumaBrutto: firstNonEmpty(fa.Rozliczenie?.DoZaplaty, fa.P_15),
    obciazenia,
    platnosc: parsePlatnosc(fa.Platnosc),
    korekta: parseKorekta(fa),
    dodatkowyOpis,
  };
}

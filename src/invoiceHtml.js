/**
 * Renderuje prosty, czytelny layout HTML (A4, do konwersji na PDF przez
 * wkhtmltopdf) na podstawie danych sparsowanych z XML FA(3) przez
 * invoiceParser.js. Własny layout - patrz komentarz w invoiceParser.js
 * dlaczego (brak oficjalnego szablonu MF) i jakie pola są/nie są pokryte.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function partyBlock(title, party) {
  if (!party) return `<div class="party"><h3>${title}</h3><p>brak danych</p></div>`;
  return `
    <div class="party">
      <h3>${title}</h3>
      <p><strong>${escapeHtml(party.nazwa)}</strong></p>
      <p>NIP: ${escapeHtml(party.nip)}</p>
      <p>${escapeHtml(party.adres)}</p>
    </div>`;
}

function itemsRows(pozycje) {
  if (!pozycje.length) {
    return '<tr><td colspan="7" style="text-align:center;color:#888;">brak pozycji</td></tr>';
  }
  return pozycje
    .map(
      (p) => `
    <tr>
      <td>${escapeHtml(p.lp)}</td>
      <td>${escapeHtml(p.nazwa)}</td>
      <td class="num">${escapeHtml(p.ilosc)} ${escapeHtml(p.jednostka)}</td>
      <td class="num">${escapeHtml(p.cenaNetto)}</td>
      <td class="num">${escapeHtml(p.wartoscNetto)}</td>
      <td class="num">${escapeHtml(p.stawkaVat)}%</td>
      <td class="num">${escapeHtml(p.wartoscBrutto)}</td>
    </tr>`,
    )
    .join('');
}

function korektaBlock(korekta) {
  if (!korekta) return '';
  const odnosnik = [korekta.numerFaktury, korekta.dataWystawienia && `z dnia ${korekta.dataWystawienia}`]
    .filter(Boolean)
    .join(' ');
  return `
  <div class="korekta-box">
    ${odnosnik ? `<p><strong>Faktura korygująca do:</strong> ${escapeHtml(odnosnik)}</p>` : ''}
    ${korekta.przyczyna ? `<p><strong>Przyczyna korekty:</strong> ${escapeHtml(korekta.przyczyna)}</p>` : ''}
  </div>`;
}

function paymentLines(inv) {
  const p = inv.platnosc;
  const lines = [];

  if (p?.formaPlatnosci) lines.push(`Forma płatności: ${escapeHtml(p.formaPlatnosci)}`);
  if (p?.terminPlatnosci) lines.push(`Termin płatności: ${escapeHtml(p.terminPlatnosci)}`);
  if (p) {
    lines.push(
      p.zaplacono
        ? `Zapłacono${p.dataZaplaty ? `: ${escapeHtml(p.dataZaplaty)}` : ': tak'}`
        : 'Zapłacono: nie',
    );
  }
  if (p?.rachunekBankowy?.numer) {
    const bank = p.rachunekBankowy.bank ? ` (${escapeHtml(p.rachunekBankowy.bank)})` : '';
    lines.push(`Rachunek bankowy: ${escapeHtml(p.rachunekBankowy.numer)}${bank}`);
  }
  if (p?.rachunekBankowy?.swift) lines.push(`SWIFT: ${escapeHtml(p.rachunekBankowy.swift)}`);

  return lines;
}

function chargesRows(obciazenia) {
  if (!obciazenia?.length) return '';
  return obciazenia
    .map(
      (o) =>
        `<tr><td>${escapeHtml(o.powod || 'Dodatkowa opłata')}</td><td class="num">${escapeHtml(o.kwota)}</td></tr>`,
    )
    .join('');
}

function additionalInfoBlock(dodatkowyOpis) {
  if (!dodatkowyOpis?.length) return '';
  const items = dodatkowyOpis
    .map((d) => `<li>${escapeHtml(d.klucz)}: ${escapeHtml(d.wartosc)}</li>`)
    .join('');
  return `
  <div class="additional-info">
    <h3>Dodatkowe informacje</h3>
    <ul>${items}</ul>
  </div>`;
}

function trzeciPodmiotBlock(trzeciPodmiot) {
  if (!trzeciPodmiot) return '';
  return `
  <div class="party" style="margin-bottom: 18px;">
    <h3>Podmiot trzeci${trzeciPodmiot.rola ? ` (rola: ${escapeHtml(trzeciPodmiot.rola)})` : ''}</h3>
    <p><strong>${escapeHtml(trzeciPodmiot.nazwa)}</strong></p>
    ${trzeciPodmiot.nip ? `<p>NIP: ${escapeHtml(trzeciPodmiot.nip)}</p>` : ''}
    <p>${escapeHtml(trzeciPodmiot.adres)}</p>
  </div>`;
}

/**
 * @param {ReturnType<import('./invoiceParser.js').parseInvoiceXml>} inv
 * @param {'koszt'|'przychod'} kierunek
 */
export function renderInvoiceHtml(inv, kierunek) {
  const kierunekLabel = kierunek === 'przychod' ? 'Faktura przychodowa (sprzedaż)' : 'Faktura kosztowa (zakup)';

  const okresRozliczeniowy = inv.okresOd && inv.okresDo ? `${inv.okresOd} - ${inv.okresDo}` : '';

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<style>
  /* Uwaga: wkhtmltopdf renderuje bardzo starym silnikiem WebKit (QtWebKit,
     bazowo ~2013) ze słabym/niepełnym wsparciem flexboksa - layout poniżej
     celowo używa tylko tabel i floatów, nie "display: flex". */
  @page { size: A4; margin: 18mm 15mm; }
  body { font-family: "DejaVu Sans", Arial, sans-serif; font-size: 11px; color: #1a1a1a; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h3 { font-size: 12px; margin: 0 0 6px; color: #444; text-transform: uppercase; letter-spacing: 0.03em; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 10px; background: #eef2ff; color: #3730a3; margin-bottom: 10px; }
  .header-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  .header-table td { border: none; padding: 0; vertical-align: top; }
  .header-table .meta { text-align: right; font-size: 11px; }
  .header-rule { border-bottom: 2px solid #1a1a1a; margin-bottom: 18px; }
  .korekta-box { background: #fff7ed; border: 1px solid #fdba74; border-radius: 4px; padding: 8px 12px; margin-bottom: 18px; }
  .korekta-box p { margin: 2px 0; }
  .parties-table { width: 100%; border-collapse: separate; border-spacing: 12px 0; margin: 0 0 18px -12px; }
  .parties-table td { border: none; padding: 0; vertical-align: top; width: 50%; }
  .party { border: 1px solid #ddd; border-radius: 4px; padding: 10px 12px; }
  .party p { margin: 2px 0; }
  table.items, table.totals-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  table.items th, table.items td { border: 1px solid #ddd; padding: 5px 6px; font-size: 10.5px; }
  table.items th { background: #f4f4f5; text-align: left; }
  td.num, th.num { text-align: right; }
  table.totals-table { width: 260px; margin-left: auto; margin-right: 0; }
  table.totals-table td { border: none; padding: 3px 6px; }
  table.totals-table .grand { font-weight: bold; font-size: 13px; border-top: 2px solid #1a1a1a; }
  .footer { font-size: 10px; color: #555; border-top: 1px solid #ddd; padding-top: 8px; }
  .footer p { margin: 2px 0; }
  .additional-info { font-size: 10px; color: #444; margin-top: 10px; }
  .additional-info ul { margin: 4px 0; padding-left: 16px; }
  .disclaimer { margin-top: 24px; font-size: 8.5px; color: #999; }
</style>
</head>
<body>
  <table class="header-table">
    <tr>
      <td>
        <div class="badge">${escapeHtml(kierunekLabel)}</div>
        <h1>Faktura ${escapeHtml(inv.numerFaktury)}</h1>
      </td>
      <td class="meta">
        <p>Data wystawienia: ${escapeHtml(inv.dataWystawienia)}</p>
        ${inv.dataDostawy ? `<p>Data dostawy/wykonania usługi: ${escapeHtml(inv.dataDostawy)}</p>` : ''}
        ${okresRozliczeniowy ? `<p>Okres rozliczeniowy: ${escapeHtml(okresRozliczeniowy)}</p>` : ''}
        <p>Miejsce wystawienia: ${escapeHtml(inv.miejsceWystawienia)}</p>
        <p>Waluta: ${escapeHtml(inv.waluta)}</p>
      </td>
    </tr>
  </table>
  <div class="header-rule"></div>

  ${korektaBlock(inv.korekta)}

  <table class="parties-table">
    <tr>
      <td>${partyBlock('Sprzedawca', inv.sprzedawca)}</td>
      <td>${partyBlock('Nabywca', inv.nabywca)}</td>
    </tr>
  </table>

  ${trzeciPodmiotBlock(inv.trzeciPodmiot)}

  <table class="items">
    <thead>
      <tr>
        <th>Lp.</th>
        <th>Nazwa</th>
        <th class="num">Ilość</th>
        <th class="num">Cena netto</th>
        <th class="num">Wartość netto</th>
        <th class="num">VAT</th>
        <th class="num">Wartość brutto</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows(inv.pozycje)}
    </tbody>
  </table>

  <table class="totals-table">
    ${chargesRows(inv.obciazenia)}
    <tr class="grand"><td>Do zapłaty</td><td class="num">${escapeHtml(inv.sumaBrutto)} ${escapeHtml(inv.waluta)}</td></tr>
  </table>

  <div class="footer">
    ${paymentLines(inv)
      .map((line) => `<p>${line}</p>`)
      .join('')}
  </div>

  ${additionalInfoBlock(inv.dodatkowyOpis)}

  <p class="disclaimer">
    Wizualizacja wygenerowana automatycznie na podstawie XML z KSeF - nie jest
    oficjalnym szablonem Ministerstwa Finansów. Dokumentem źródłowym i prawnie
    wiążącym jest plik XML dołączony obok tego PDF.
  </p>
</body>
</html>`;
}

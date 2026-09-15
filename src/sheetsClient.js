/**
 * Cienki klient Google Sheets API dla rejestru faktur (src/invoiceRegister.js).
 * Ten sam wzorzec OAuth co driveClient.js - reużywa GOOGLE_OAUTH_CLIENT_ID/
 * SECRET/REFRESH_TOKEN, ale refresh token musi mieć dodatkowo zakres
 * `spreadsheets` (patrz scripts/get-refresh-token.js) - stary token wygenerowany
 * tylko z `drive`+`gmail.send` NIE zadziała tutaj (403 insufficientPermissions),
 * trzeba go wygenerować ponownie.
 */
import { google } from 'googleapis';
import { config } from './config.js';

let sheetsInstance = null;

function getSheets() {
  if (sheetsInstance) return sheetsInstance;

  const oauth2Client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oauth2Client.setCredentials({ refresh_token: config.google.refreshToken });

  sheetsInstance = google.sheets({ version: 'v4', auth: oauth2Client });
  return sheetsInstance;
}

export async function createSpreadsheet(title, sheetTitle, headerRow) {
  const sheets = getSheets();

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: sheetTitle } }],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headerRow] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: created.data.sheets[0].properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: created.data.sheets[0].properties.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    },
  });

  return spreadsheetId;
}

/**
 * Zwraca wszystkie wiersze danych (bez nagłówka) jako tablicę tablic stringów,
 * z `range` zaczynającym się od wiersza 2 (A2:<ostatnia kolumna>).
 */
export async function getValues(spreadsheetId, sheetTitle, lastColumnLetter) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A2:${lastColumnLetter}`,
  });
  return res.data.values ?? [];
}

export async function appendRow(spreadsheetId, sheetTitle, row) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetTitle}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

/**
 * Nadpisuje pojedynczą komórkę, np. kolumnę "duplikat" w konkretnym wierszu
 * (1-indeksowany numer wiersza w arkuszu, wliczając nagłówek).
 */
export async function updateCell(spreadsheetId, sheetTitle, cellA1, value) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!${cellA1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

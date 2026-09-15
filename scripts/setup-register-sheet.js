/**
 * Jednorazowy skrypt: tworzy arkusz Google Sheets "Rejestr faktur" (zakładka
 * "Faktury", nagłówki z src/invoiceRegister.js) na koncie Google powiązanym z
 * GOOGLE_OAUTH_REFRESH_TOKEN i wypisuje GOOGLE_REGISTER_SHEET_ID do wklejenia
 * do .env.
 *
 * WYMAGA refresh tokenu z zakresem `spreadsheets` - jeśli .env ma jeszcze
 * stary token (sprzed dodania rejestru, tylko `drive`+`gmail.send`), najpierw
 * uruchom ponownie `npm run get-refresh-token` i podmień
 * GOOGLE_OAUTH_REFRESH_TOKEN, inaczej dostaniesz błąd 403 insufficientPermissions.
 */
import 'dotenv/config';
import { createRegisterSheet } from '../src/invoiceRegister.js';

if (process.env.GOOGLE_REGISTER_SHEET_ID) {
  console.log(
    `GOOGLE_REGISTER_SHEET_ID jest już ustawiony (${process.env.GOOGLE_REGISTER_SHEET_ID}) - nic nie robię.\n` +
      'Jeśli naprawdę chcesz utworzyć NOWY, pusty rejestr, usuń tę zmienną z .env i uruchom ponownie.',
  );
  process.exit(0);
}

try {
  const spreadsheetId = await createRegisterSheet();
  console.log('\n=== SUKCES ===');
  console.log(`Utworzono arkusz: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\n`);
  console.log('Dopisz poniższą linię do .env:\n');
  console.log(`GOOGLE_REGISTER_SHEET_ID=${spreadsheetId}\n`);
} catch (err) {
  console.error('Nie udało się utworzyć arkusza:', err.message);
  process.exitCode = 1;
}

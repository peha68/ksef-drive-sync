/**
 * Jednorazowy skrypt pomocniczy: przeprowadza autoryzację OAuth 2.0 w
 * przeglądarce i wymienia kod na refresh_token dla konta Google Drive.
 *
 * Uruchamiany LOKALNIE (tam gdzie masz przeglądarkę), nie na serwerze
 * produkcyjnym. Wynikowy GOOGLE_OAUTH_REFRESH_TOKEN wklejasz ręcznie do
 * .env na serwerze.
 *
 * Wymaga w .env (lokalnie): GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
 * (z ekranu "Dane logowania -> Identyfikator klienta OAuth" w Google Cloud
 * Console, typ aplikacji: Desktop app).
 */
import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Brak zmiennej ${name} w .env - uzupełnij ją przed uruchomieniem tego skryptu.`);
  }
  return value;
}

const clientId = required('GOOGLE_OAUTH_CLIENT_ID');
const clientSecret = required('GOOGLE_OAUTH_CLIENT_SECRET');

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // wymusza wydanie refresh_token nawet przy ponownej autoryzacji
  scope: [
    'https://www.googleapis.com/auth/drive',
    // Tylko wysyłanie maila (podsumowanie synchronizacji) - nie czytanie skrzynki.
    'https://www.googleapis.com/auth/gmail.send',
  ],
});

console.log('\n1. Otwórz ten link w przeglądarce i zaloguj się na konto, którego Dysk ma być używany:\n');
console.log(authUrl);
console.log(
  '\n2. Google może pokazać ostrzeżenie "Aplikacja niezweryfikowana" - to Twoja własna\n' +
    '   aplikacja, więc kliknij "Zaawansowane" -> "Przejdź do ksef-drive-sync (niebezpieczne)".\n',
);
console.log(`Nasłuchuję odpowiedzi na ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Autoryzacja odrzucona: ${error}. Możesz zamknąć to okno.`);
    console.error(`Błąd autoryzacji: ${error}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Brak kodu autoryzacji w odpowiedzi.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Autoryzacja zakończona. Możesz zamknąć to okno i wrócić do terminala.');

    if (!tokens.refresh_token) {
      console.warn(
        '\nUWAGA: Google nie zwrócił refresh_token. Zwykle oznacza to, że to konto\n' +
          'już wcześniej autoryzowało tę aplikację (bez "prompt=consent" Google zwraca\n' +
          'refresh_token tylko raz). Cofnij dostęp na\n' +
          'https://myaccount.google.com/permissions i uruchom ten skrypt ponownie.\n',
      );
    } else {
      console.log('\n=== SUKCES ===');
      console.log('Dopisz poniższą linię do pliku .env NA SERWERZE:\n');
      console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }
  } catch (err) {
    console.error('Nie udało się wymienić kodu na tokeny:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Błąd wymiany kodu na tokeny - sprawdź terminal.');
  } finally {
    server.close();
  }
});

server.listen(PORT);

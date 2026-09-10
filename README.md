# ksef-drive-sync

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![KSeF](https://img.shields.io/badge/KSeF-2.0-blue.svg)](https://ksef.podatki.gov.pl/)

Skrypt Node.js, który okresowo pobiera faktury z KSeF 2.0 (koszty i/lub
przychody - patrz `KSEF_SUBJECT_ROLE`) i zapisuje je na Dysku Google w
strukturze `<folder główny>/<rok>/<miesiąc>/ksef_<koszt|przychod>_<numer>.xml`,
razem z obok leżącym `.pdf` o tej samej nazwie (prosta wizualizacja - patrz
sekcja "Generowanie PDF" niżej). Po każdym uruchomieniu wysyła mailowe
podsumowanie (ile faktur wgrano, jakie, czy były błędy) - patrz sekcja
"Powiadomienia mailowe".

Nie kategoryzuje faktur (np. nie rozpoznaje "Paliwo") — to jest świadoma
decyzja: prostsza logika, mniej miejsc do popsucia. Ręczne rozdzielanie do
kategorii zostaje po Twojej stronie. Rozróżnienie koszt/przychód po
prefiksie w nazwie pliku jest jedynym wbudowanym podziałem.

## Wymagania

- **Node.js 20+** (deweloperski/produkcyjny runtime; `engines` w `package.json`).
- **Konto w KSeF 2.0** z wygenerowanym tokenem autoryzacyjnym **albo**
  certyfikatem KSeF (test i/lub prod) - patrz sekcja "Konfiguracja KSeF".
- **Konto Google** (Gmail) z dostępem do Google Cloud Console, do skonfigurowania
  OAuth 2.0 dla Google Drive API i Gmail API - patrz sekcja "Autoryzacja
  Google Drive (OAuth)". Nie jest wymagane konto Google Workspace - zwykłe,
  darmowe konto Gmail wystarczy.
- **`wkhtmltopdf`** zainstalowany w systemie (`sudo apt install wkhtmltopdf`
  na Debianie/Ubuntu) - tylko do generowania PDF-ów; bez tego reszta
  skryptu i tak działa (patrz sekcja "Generowanie PDF").
- Serwer/maszyna z **systemd**, jeśli chcesz automatycznego, cyklicznego
  uruchamiania (opisane dla Debiana, ale systemd timer działa tak samo na
  każdej dystrybucji Linuksa, która go ma). Bez systemd da się uruchamiać
  ręcznie albo przez `cron`.

## Struktura projektu

```
ksef-drive-sync/
├── src/
│   ├── index.js            # Główny skrypt - codzienna synchronizacja (KSeF -> Drive)
│   ├── config.js           # Wczytywanie i walidacja zmiennych z .env
│   ├── ksefClient.js        # Wrapper wokół biblioteki ksef-client-ts (auth, zapytania, pobieranie XML)
│   ├── driveClient.js       # Operacje na Google Drive (foldery, upload, listowanie, linki)
│   ├── invoiceParser.js     # Parsuje XML FA(3) do prostego obiektu JS
│   ├── invoiceHtml.js       # Renderuje obiekt faktury do HTML (layout PDF)
│   ├── pdfRenderer.js       # Konwertuje HTML -> PDF przez wkhtmltopdf
│   ├── mailClient.js        # Wysyłka maili przez Gmail API (z załącznikami)
│   ├── monthlyArchive.js    # Archiwum miesięczne: ZIP za poprzedni miesiąc -> mail
│   └── logger.js            # Prosty logger (konsola + plik data/sync.log)
├── scripts/
│   ├── get-refresh-token.js # Jednorazowa autoryzacja OAuth (uruchamiane lokalnie)
│   └── backfill-pdfs.js     # Dogenerowuje brakujące PDF-y dla już pobranych XML-i
├── systemd/
│   ├── ksef-drive-sync.service / .timer          # Codzienny sync
│   └── ksef-drive-sync-monthly.service / .timer  # Miesięczne archiwum (10. dnia)
├── data/                    # Log (data/sync.log) - tworzone automatycznie, w .gitignore
├── certs/                   # Certyfikat KSeF (.crt/.key), tylko przy KSEF_AUTH_METHOD=certificate - w .gitignore
├── .env.example             # Szablon konfiguracji (skopiuj do .env i uzupełnij)
└── .env                     # Twoja prawdziwa konfiguracja z sekretami - NIGDY nie commituj (w .gitignore)
```

Przepływ danych w skrócie: `index.js` woła `ksefClient.js` (pobranie faktur),
potem `driveClient.js` (upload XML), potem `invoiceParser.js` ->
`invoiceHtml.js` -> `pdfRenderer.js` (wygenerowanie i upload PDF), na końcu
`mailClient.js` (podsumowanie). `monthlyArchive.js` i `backfill-pdfs.js` to
osobne wejścia korzystające z tych samych modułów (`driveClient.js`,
`invoiceParser.js` itd.) - nie duplikują logiki.

## Ważna uwaga o bibliotece KSeF

Ministerstwo Finansów nie publikuje oficjalnego SDK dla Node.js. Ten projekt
korzysta z nieoficjalnej, community biblioteki `ksef-client-ts`
(https://github.com/Flopsstuff/ksef-client-ts), żeby nie implementować od
zera szyfrowania RSA/AES i podpisów XAdES wymaganych przez API KSeF 2.0.

**Przed pierwszym uruchomieniem:**
1. `npm install`
2. API biblioteki (wersja `0.2.0`) zostało zweryfikowane względem
   `node_modules/ksef-client-ts/dist/index.d.ts` — `src/ksefClient.js` używa
   `client.loginWithToken(token, nip)`, `client.invoices.queryInvoiceMetadata(...)`
   i `client.invoices.getInvoice(ksefNumber)`. Jeśli zaktualizujesz pakiet do
   nowszej wersji, sprawdź ponownie te sygnatury w tym samym pliku `.d.ts` i
   popraw tylko `src/ksefClient.js`, jeśli się zmieniły.
3. Przetestuj cały przepływ na środowisku **test** (`KSEF_ENV=test`), zanim
   przełączysz na `prod`.

## 1. Konfiguracja KSeF

Projekt obsługuje **dwie metody uwierzytelniania**, przełączane jedną
zmienną `KSEF_AUTH_METHOD` w `.env` (`token` albo `certificate`) — patrz
`src/ksefClient.js`. Wypełnij tylko sekcję `.env` odpowiadającą wybranej
metodzie.

### 1a. Metoda `token` (domyślna, prostsza)

1. Zaloguj się do aplikacji KSeF (https://ksef.mf.gov.pl) swoim NIP-em.
2. W zakładce dot. tokenów wygeneruj **token autoryzacyjny** z uprawnieniem
   do odczytu/pobierania faktur.
3. Zapisz go w `.env` jako `KSEF_AUTH_TOKEN` (patrz `.env.example`).

⚠️ Token KSeF przestanie działać **31.12.2026** — dlatego istnieje też
metoda `certificate` poniżej.

### 1b. Metoda `certificate`

KSeF 2.0 wprowadził własny, **bezpłatny** typ certyfikatu (osobny od
płatnego, komercyjnego podpisu kwalifikowanego) - dla jednoosobowej
działalności gospodarczej wystarczy darmowy **Profil Zaufany**, żeby go
zdobyć.

1. Wejdź na https://ksef.podatki.gov.pl -> "Bezpłatne narzędzia KSeF 2.0" ->
   **Aplikacja Podatnika KSeF 2.0**.
2. Zaloguj się Profilem Zaufanym (albo podpisem/pieczęcią kwalifikowaną,
   jeśli już je masz).
3. Złóż wniosek o **certyfikat Typ 1** ("uwierzytelnienie") - Typ 2 jest do
   trybu offline/awaryjnego i tu jest niepotrzebny.
4. Aplikacja wygeneruje parę plików do pobrania: certyfikat (`.crt`) i
   klucz prywatny (`.key`, zwykle zaszyfrowany hasłem). Certyfikat ważny
   maks. 2 lata, powiązany z Twoim NIP-em.
5. Jeśli klucz jest zaszyfrowany, odszyfruj go lokalnie (poda hasło tylko
   w Twoim terminalu, nigdy nikomu indziej):
   ```bash
   openssl pkey -in twoj-klucz.key -out twoj-klucz-decrypted.key
   ```
6. Umieść oba pliki w katalogu `certs/` w tym projekcie (katalog jest w
   `.gitignore` - **nigdy nie commituj tych plików**), np. `certs/ksef.crt`
   i `certs/ksef.key`.
7. W `.env` ustaw:
   ```
   KSEF_AUTH_METHOD=certificate
   KSEF_CERT_FILE=./certs/ksef.crt
   KSEF_KEY_FILE=./certs/ksef.key
   ```

Na serwerze pamiętaj o restrykcyjnych uprawnieniach na klucz prywatny:
`chmod 600 certs/ksef.key` (analogicznie do `.env`).

## 1c. Generowanie PDF

⚠️ **Ministerstwo Finansów nie publikuje oficjalnego szablonu wizualizacji
dla FA(3)** (sprawdzone na ksef.podatki.gov.pl - w przeciwieństwie do
starszego KSeF 1.0/FA(2), gdzie taki szablon istniał). PDF-y generowane przez
ten skrypt (`src/invoiceParser.js` + `src/invoiceHtml.js`) to **własny,
uproszczony layout**, nie urzędowy wzór. Dokumentem źródłowym i prawnie
wiążącym pozostaje zawsze plik XML leżący obok.

Konwersja HTML -> PDF wymaga zainstalowanego na serwerze binarki
`wkhtmltopdf`:

```bash
sudo apt install -y wkhtmltopdf
```

Jeśli binarki brak, generowanie PDF dla danej faktury po prostu nie powiedzie
się (błąd w logu, licznik "błędy PDF" w podsumowaniu) - XML i tak zostanie
pobrany i wgrany normalnie, PDF nie jest wymagany do działania reszty
skryptu.

## 2. Autoryzacja Google Drive (OAuth)

**Zmiana względem pierwotnego planu:** pierwotnie projekt miał używać konta
serwisowego (service account) z plikiem klucza JSON — bez okienek
przeglądarki i bez odświeżania tokenów. W praktyce Google od pewnego czasu
domyślnie wymusza na nowych projektach politykę
`iam.disableServiceAccountKeyCreation` (nawet bez formalnej organizacji -
dotyczy to też darmowych kont Gmail), która blokuje generowanie takich
kluczy; nie zawsze da się ją wyłączyć na poziomie projektu (zależy od
uprawnień konta). Jeśli u Ciebie się uda - możesz spróbować wrócić do
service account, to prostsze rozwiązanie. U nas się nie udało, więc
używamy OAuth 2.0 z jednorazowo wygenerowanym **refresh tokenem** — po
jednorazowej autoryzacji w przeglądarce skrypt działa już bez nadzoru
(refresh token nie wygasa, dopóki appka jest opublikowana jako "In
production" — patrz krok 3 poniżej).

### 2a. Projekt w Google Cloud Console

1. Wejdź na https://console.cloud.google.com i utwórz nowy projekt (albo użyj
   istniejącego).
2. **APIs & Services -> Library** -> wyszukaj "Google Drive API" -> **Enable**.
3. Tam samo dla **"Gmail API"** -> **Enable** (potrzebne do wysyłki maila z
   podsumowaniem, patrz sekcja "Powiadomienia mailowe").

### 2b. Ekran zgody OAuth (OAuth consent screen)

1. **APIs & Services -> OAuth consent screen**.
2. Typ użytkownika: **Zewnętrzny (External)**.
3. Wypełnij nazwę aplikacji (np. `ksef-drive-sync`), e-mail wsparcia i e-mail
   deweloperski — oba Twoim adresem Gmail (tym, na którym jest docelowy Dysk).
4. Zakres (scope) niepotrzebny do dodania ręcznie na tym ekranie — żąda go
   skrypt `scripts/get-refresh-token.js` (`https://www.googleapis.com/auth/drive`
   i `https://www.googleapis.com/auth/gmail.send` - to drugie tylko do
   wysyłania maila z podsumowaniem, nie do czytania skrzynki).
5. **Ważne:** przełącz **Publishing status** na **"In production"** (nie
   zostawiaj "Testing"). W trybie "Testing" Google unieważnia refresh token po
   7 dniach, co wywaliłoby codzienny sync po tygodniu. Appka nie musi
   przechodzić pełnej weryfikacji Google — to jednoosobowe użycie, więc przy
   logowaniu zobaczysz ostrzeżenie "Google nie zweryfikował tej aplikacji";
   to normalne, klikasz "Zaawansowane" -> "Przejdź do ksef-drive-sync
   (niebezpieczne)".

### 2c. Dane logowania OAuth (OAuth client ID)

1. **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**.
2. Typ aplikacji: **Desktop app**. Nazwa dowolna.
3. Po utworzeniu skopiuj **Client ID** i **Client Secret**.
4. Wklej je **lokalnie** (na swoim komputerze, nie na serwerze) do pliku
   `.env` w tym repo jako `GOOGLE_OAUTH_CLIENT_ID` i `GOOGLE_OAUTH_CLIENT_SECRET`.

### 2d. Wygenerowanie refresh tokenu (jednorazowo, lokalnie)

1. Lokalnie (tam gdzie masz przeglądarkę): `npm install` (jeśli jeszcze nie
   zrobione), potem `npm run get-refresh-token`.
2. Skrypt wypisze link — otwórz go w przeglądarce, zaloguj się na **swoje
   konto Gmail** (to, którego Dysk ma być używany), zaakceptuj ostrzeżenie
   o niezweryfikowanej appce (patrz 2b/5) i zezwól na dostęp do Dysku.
3. Skrypt automatycznie odbierze odpowiedź (lokalny serwerek na
   `http://localhost:8765`) i wypisze w terminalu linię
   `GOOGLE_OAUTH_REFRESH_TOKEN=...`.
4. Skopiuj tę linię do `.env` **na serwerze** (obok `GOOGLE_OAUTH_CLIENT_ID`
   i `GOOGLE_OAUTH_CLIENT_SECRET`, które też muszą tam trafić).

### 2e. Folder docelowy na Dysku

Ponieważ logujemy się jako Ty (Twoje własne konto Gmail), a nie jako osobne
konto, **nie trzeba nic udostępniać** — masz już dostęp do własnego folderu.

1. Utwórz (albo wybierz istniejący) folder na Dysku Google, w którym mają
   lądować faktury, np. "Faktury i rozliczenia".
2. Skopiuj jego ID z adresu URL w przeglądarce (fragment po `/folders/`) i
   wklej do `.env` jako `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

## 2f. Powiadomienia mailowe

Po każdym uruchomieniu (udanym czy nie) skrypt wysyła mail przez Gmail API na
adres z `NOTIFY_EMAIL` w `.env` - ten sam refresh token co Dysk, wymaga
zakresu `gmail.send` (patrz 2b/4 i 2d) oraz włączonego **Gmail API** w
projekcie (patrz 2a/3).

Treść: zakres dat, liczba znalezionych/wgranych/pominiętych/błędnych faktur,
lista nowo wgranych faktur (numer KSeF, koszt/przychód, kontrahent, kwota), a
przy błędach - ich lista. Błąd samej wysyłki maila (np. wygasły dostęp) jest
tylko logowany, nie przerywa ani nie psuje wyniku synchronizacji.

## 3. Instalacja na serwerze Debian

```bash
sudo apt update && sudo apt install -y nodejs npm wkhtmltopdf   # jeśli jeszcze nie ma Node.js 20+
sudo mkdir -p /opt/ksef-drive-sync
sudo useradd --system --home /opt/ksef-drive-sync --shell /usr/sbin/nologin ksefsync
# skopiuj tu zawartość tego projektu, plus wypełniony .env (z tokenami OAuth)
sudo chown -R ksefsync:ksefsync /opt/ksef-drive-sync
cd /opt/ksef-drive-sync
sudo -u ksefsync npm install --omit=dev
```

Testowe, ręczne uruchomienie (zanim ustawisz automatyzację):

```bash
sudo -u ksefsync node src/index.js
```

Sprawdź log w `data/sync.log` i czy pliki faktycznie wylądowały w odpowiednim
folderze na Dysku.

## 4. Automatyczne uruchamianie (systemd timer)

```bash
sudo cp systemd/ksef-drive-sync.service /etc/systemd/system/
sudo cp systemd/ksef-drive-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ksef-drive-sync.timer
```

Domyślnie: codziennie o 5:30 (+do 10 min losowego przesunięcia). Zmienisz to,
edytując `OnCalendar` w `ksef-drive-sync.timer`.

Podgląd logów systemd:
```bash
journalctl -u ksef-drive-sync.service -f
```

(Alternatywa bez systemd: standardowy wpis w `crontab -e` wywołujący
`node /opt/ksef-drive-sync/src/index.js` — jeśli wolisz to podejście, powiedz,
dopiszę przykładową linię.)

## 5. Archiwum miesięczne (ZIP dla księgowości)

10. dnia każdego miesiąca `src/monthlyArchive.js` pakuje wszystkie pliki z
folderu `<rok>/<poprzedni miesiąc>` (faktury XML/PDF z KSeF **i** ręczne
skany `scan_koszt_*`) do jednego ZIP-a i wysyła go mailem.

**Bezpiecznik:** dopóki `MONTHLY_ARCHIVE_SEND_TO_ACCOUNTING=false` w `.env`,
mail leci **tylko** na `NOTIFY_EMAIL` (do testów) — księgowość (`ACCOUNTING_EMAIL`)
nic nie dostaje, nawet jeśli adres jest wypełniony. Przełącz flagę na `true`
dopiero po sprawdzeniu, że testowe archiwa wyglądają dobrze.

Jeśli ZIP przekroczy ~15MB (możliwe przy wielu skanach/zdjęciach w jednym
miesiącu) - zamiast załącznika, plik trafia do folderu `_Archiwa_miesieczne`
na Dysku (udostępniony jako "każdy z linkiem może wyświetlić", bo księgowość
niekoniecznie ma konto Google powiązane z tym adresem), a mail zawiera link
zamiast pliku.

Instalacja (analogicznie do kroku 4, osobny timer):

```bash
sudo cp systemd/ksef-drive-sync-monthly.service /etc/systemd/system/
sudo cp systemd/ksef-drive-sync-monthly.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ksef-drive-sync-monthly.timer
```

Ręczny test w dowolnym momencie (pakuje *poprzedni* miesiąc względem dzisiejszej daty):

```bash
sudo -u ksefsync node src/monthlyArchive.js
```

## 6. Uzupełnianie brakujących PDF-ów

Dedup w `src/index.js` sprawdza tylko obecność pliku XML - jeśli PDF się nie
udał (np. brak zainstalowanego `wkhtmltopdf` w danym momencie), nie jest
automatycznie ponawiany przy kolejnych uruchomieniach. `scripts/backfill-pdfs.js`
to narzędzie porządkowe: przechodzi po wszystkich folderach `<rok>/<miesiąc>`,
znajduje faktury XML bez odpowiadającego PDF-a i dogenerowuje brakujące - na
podstawie XML-a już leżącego na Dysku, **bez ponownego odpytywania KSeF**.

```bash
npm run backfill-pdfs
```

Uruchamiaj ręcznie, kiedy potrzeba (np. po naprawieniu `wkhtmltopdf` na
serwerze, albo po zmianie layoutu PDF - patrz `src/invoiceHtml.js` - i
chęci przegenerowania starszych faktur nowym wyglądem).

## Testowanie

Ten projekt **nie ma automatycznego zestawu testów** (bez Jest/Vitest, bez
CI) - to prosty, jednoosobowy skrypt, nie biblioteka. Zamiast tego poniżej
jest praktyczny sposób ręcznej weryfikacji każdego elementu z osobna, zanim
zaufasz całości na produkcji. Dokładnie tak testowałem ten projekt podczas
budowy.

**1. Środowisko test KSeF przed prod.** Ustaw `KSEF_ENV=test` w `.env` i
zaloguj się na https://ksef-test.mf.gov.pl, żeby wygenerować testowy token -
dopiero po potwierdzeniu, że autoryzacja działa, przełącz na `prod`.

**2. Samo zapytanie o faktury, bez pobierania/wgrywania** - szybki test
połączenia z KSeF bez ryzyka utworzenia czegokolwiek:
```bash
node -e "
const { queryInvoices } = await import('./src/ksefClient.js');
const dateTo = new Date();
const dateFrom = new Date(); dateFrom.setDate(dateFrom.getDate() - 7);
const invoices = await queryInvoices(dateFrom, dateTo);
console.log('Znaleziono:', invoices.length);
" --input-type=module
```

**3. Dostęp do Dysku, bez KSeF** - sprawdza samo OAuth + docelowy folder:
```bash
node -e "
const { google } = await import('googleapis');
const { config } = await import('./src/config.js');
const oauth2Client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
oauth2Client.setCredentials({ refresh_token: config.google.refreshToken });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const res = await drive.files.get({ fileId: config.google.rootFolderId, fields: 'name' });
console.log('Folder docelowy:', res.data.name);
" --input-type=module
```

**4. Generowanie PDF w izolacji** (bez dotykania KSeF/Drive) - potwierdza,
że `wkhtmltopdf` faktycznie działa w środowisku, w którym uruchamiasz
skrypt (ważne: testuj tym samym użytkownikiem systemowym, np. `ksefsync`,
którym realnie chodzi usługa - `PATH` bywa inny niż w Twojej interaktywnej
sesji):
```bash
node -e "
const { renderPdfFromHtml } = await import('./src/pdfRenderer.js');
const pdf = await renderPdfFromHtml('<html><body><h1>Test</h1></body></html>');
console.log('PDF:', pdf.length, 'bajtów');
" --input-type=module
```

**5. Parser XML na realnej fakturze** - schemat FA(3) ma sporo wariantów
(różni wystawcy, różne pola opcjonalne) - warto sprawdzić parser na
własnych, prawdziwych danych, nie tylko na przykładzie z `ksef.podatki.gov.pl`:
```bash
node -e "
const { parseInvoiceXml } = await import('./src/invoiceParser.js');
const fs = await import('node:fs');
const xml = fs.readFileSync('/ścieżka/do/faktury.xml', 'utf-8');
console.log(JSON.stringify(parseInvoiceXml(xml), null, 2));
" --input-type=module
```

**6. Wysyłka maila w izolacji:**
```bash
node -e "
const { sendMail } = await import('./src/mailClient.js');
await sendMail({ to: process.env.NOTIFY_EMAIL, subject: 'Test', text: 'Działa.' });
console.log('Wysłano.');
" --input-type=module
```

**7. Pełny przebieg, ręcznie, zanim włączysz automatyzację:**
```bash
node src/index.js
```
Sprawdź `data/sync.log`, czy pliki faktycznie wylądowały we właściwych
folderach na Dysku, i czy przyszedł mail podsumowujący. Uruchom drugi raz -
wszystko powinno zostać pominięte jako duplikaty (test dedupu).

**8. Test przez systemd, nie tylko `node src/index.js` bezpośrednio** - jeśli
wdrażasz na serwerze, koniecznie odpal usługę realnym mechanizmem, którym
będzie startować na co dzień (`ProtectSystem=strict` i inne ograniczenia w
pliku `.service` potrafią zachowywać się inaczej niż zwykłe uruchomienie
z terminala):
```bash
sudo systemctl start ksef-drive-sync.service
sudo systemctl status ksef-drive-sync.service
journalctl -u ksef-drive-sync.service -n 30 --no-pager
```

## Jak to działa w skrócie

1. Skrypt pyta KSeF o faktury z ostatnich `INVOICE_LOOKBACK_DAYS` dni (domyślnie
   7 — zapas na wypadek, gdyby serwer nie żył kilka dni), jako nabywca i/lub
   sprzedawca zależnie od `KSEF_SUBJECT_ROLE`.
2. Dla każdej faktury: sprawdza rok/miesiąc wystawienia, tworzy (jeśli trzeba)
   podfoldery na Dysku, sprawdza czy plik XML o tej nazwie już tam jest (żeby
   nie robić duplikatów przy powtórnym uruchomieniu - **dedup działa tylko po
   pliku XML**, nie po PDF), i jeśli nie — pobiera XML faktury z KSeF, wgrywa
   go jako `ksef_koszt_<numer>.xml` lub `ksef_przychod_<numer>.xml`, a
   następnie próbuje wygenerować i wgrać PDF o tej samej nazwie (patrz sekcja
   "Generowanie PDF" - błąd PDF nie przerywa reszty ani nie liczy się jako
   błąd całej faktury).
3. Między fakturami jest krótka przerwa (300ms) - KSeF w praktyce potrafi
   zacząć zawieszać połączenia (nie zwracać błędu, tylko nie odpowiadać) po
   dłuższej serii żądań w krótkim czasie; każde pojedyncze żądanie ma też
   twardy timeout 60s, po którym skrypt loguje błąd dla tej jednej faktury i
   jedzie dalej, zamiast zablokować się w nieskończoność (krytyczne przy
   cichym uruchomieniu z systemd). Faktura, która w ten sposób "wypadnie",
   zostanie automatycznie ponowiona następnego dnia, dopóki mieści się w
   oknie `INVOICE_LOOKBACK_DAYS`.
4. Wynik (ile wgrano / pominięto / błędów / błędów PDF) trafia do logu i do
   maila podsumowującego na `NOTIFY_EMAIL` (patrz sekcja "Powiadomienia
   mailowe").

## FAQ - najczęstsze problemy

**"W Twojej organizacji egzekwowana jest zasada organizacji, która
uniemożliwia tworzenie kluczy kont usługi" (przy próbie service account)**
Google od pewnego czasu domyślnie blokuje tworzenie kluczy JSON dla kont
serwisowych na nowych projektach (`iam.disableServiceAccountKeyCreation`) -
nawet bez formalnej organizacji. Można spróbować to wyłączyć w **IAM & Admin
-> Organization Policies**, ale zwykle wymaga to uprawnień wykraczających
poza rolę Właściciela projektu. Jeśli się nie uda: to dlatego ten projekt
domyślnie używa OAuth 2.0 zamiast service account - patrz sekcja
"Autoryzacja Google Drive (OAuth)".

**Błąd 403 "API has not been used in project ... or it is disabled" przy
pierwszym wywołaniu Drive/Gmail**
Trzeba ręcznie włączyć dane API w Google Cloud Console: **APIs & Services ->
Library** -> wyszukaj "Google Drive API" / "Gmail API" -> **Enable**. Zmiana
propaguje się przez kilka minut - jeśli błąd się powtarza od razu po
włączeniu, odczekaj chwilę i spróbuj ponownie.

**Skrypt `get-refresh-token.js` działał, ale po kilku dniach sync przestał
się autoryzować**
Prawdopodobnie ekran zgody OAuth jest w trybie **"Testing"** - Google
unieważnia wtedy refresh token po 7 dniach. Przełącz **Publishing status**
na **"In production"** (OAuth consent screen w Google Cloud Console) -
patrz sekcja "Autoryzacja Google Drive (OAuth)", krok 2b.

**`get-refresh-token.js` nie zwrócił `refresh_token` (tylko `access_token`)**
Google wydaje `refresh_token` tylko przy pierwszej zgodzie dla danej
kombinacji użytkownik+aplikacja+zakresy - kolejne logowania bez wymuszenia
zwracają tylko `access_token`. Skrypt już wymusza to przez
`prompt: 'consent'`, ale jeśli mimo to nie dostaniesz tokenu: cofnij dostęp
aplikacji na https://myaccount.google.com/permissions i uruchom skrypt
ponownie.

**KSeF zwraca błąd `21405` / `"dateRange" must not exceed 3 months`**
To normalne ograniczenie API KSeF 2.0 przy zapytaniach o metadane faktur -
`src/ksefClient.js` już dzieli dłuższe zakresy dat na kolejne okna ≤3
miesięcy automatycznie. Jeśli widzisz ten błąd mimo to, sprawdź czy nie
wywołujesz `queryInvoices()` bezpośrednio z własnym kodem pomijającym tę
logikę.

**Synchronizacja "wisi" bez końca / trwa bardzo długo przy pierwszym,
dużym imporcie (np. od początku roku)**
KSeF w praktyce potrafi zacząć zawieszać połączenia (bez błędu, po prostu
nie odpowiada) po dłuższej serii żądań w krótkim czasie - obserwowane przy
jednorazowym uzupełnianiu zaległości za wiele miesięcy naraz. Skrypt ma
wbudowany twardy timeout 60s na fakturę (patrz "Jak to działa w skrócie",
pkt 3), więc się nie zawiesi na stałe, ale pojedyncze faktury mogą wtedy
wylądować jako błąd. Rozwiązanie: poczekaj kilkanaście-kilkadziesiąt minut i
uruchom sync ponownie (duplikaty i tak zostaną pominięte) - albo dziel
duży, jednorazowy import na mniejsze zakresy dat.

**PDF się nie generuje / w logu "Nie znaleziono polecenia wkhtmltopdf"**
Binarka `wkhtmltopdf` nie jest zainstalowana (`sudo apt install
wkhtmltopdf`) albo nie jest w `PATH` użytkownika, którym uruchamiasz skrypt.
To nie jest błąd krytyczny - XML i tak zostanie pobrany i wgrany normalnie
(patrz sekcja "Generowanie PDF"). Po naprawieniu instalacji uzupełnij
brakujące PDF-y przez `npm run backfill-pdfs` (sekcja 6) - nie trzeba nic
pobierać ponownie z KSeF.

**PDF wygenerował się, ale jest prawie pusty (brak danych sprzedawcy/kwot)**
Jeśli trafiasz na to mimo aktualnej wersji parsera - prawdopodobnie faktura
używa jawnego prefiksu namespace w XML (`<tns:Fa>` zamiast `<Fa>`), co
zdarza się u części wystawców. `src/invoiceParser.js` ma już na to
poprawkę (`removeNSPrefix: true`), ale jeśli mimo to widzisz pustą
wizualizację dla konkretnej faktury, porównaj jej XML z przykładami w
`invoiceParser.js` - być może trafiłeś na inny, jeszcze nieobsłużony wariant
schematu.

**`node --version` na serwerze pokazuje 18.x, a projekt wymaga 20+**
Domyślne repozytoria Debiana (np. bookworm) mają starszą wersję Node.js.
Zainstaluj nowszą z NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```
⚠️ To podmienia **globalną, systemową** wersję Node - jeśli na tym samym
serwerze działają inne skrypty/usługi Node.js, upewnij się najpierw, że nie
wymagają one dokładnie wersji 18 (natywne zależności czasem trzeba wtedy
przebudować: `npm rebuild`).

**`rsync: command not found` przy przesyłaniu plików na serwer**
Świeży Debian często go nie ma domyślnie: `sudo apt install -y rsync` (po
obu stronach - i na maszynie źródłowej, i na serwerze docelowym, bo rsync
przez SSH uruchamia proces po obu stronach).

**Po `sudo rsync ...` dostaję `change_dir "/root/..." failed: No such file
or directory`**
Jeśli logujesz się jako zwykły użytkownik, a potem używasz `sudo` do
kopiowania - `sudo` **nie zmienia** `$HOME`, więc `~` w poleceniu `sudo`
nadal może rozwinąć się na katalog domowy roota (`/root`), a nie
użytkownika, który wcześniej odebrał pliki przez `rsync`/`scp`. Podaj pełną
ścieżkę jawnie (np. `/home/twoj_uzytkownik/...`) zamiast polegać na `~` w
poleceniach z `sudo`.

## Możliwe rozszerzenia na później

- Przed 31.12.2026 (wygaśnięcie tokenów KSeF): przełącz `KSEF_AUTH_METHOD`
  na `certificate` na produkcji (obsługa już gotowa, patrz sekcja "1b.
  Metoda certificate") i unieważnij stary token w aplikacji KSeF.

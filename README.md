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
- **Konto w KSeF 2.0** z wygenerowanym tokenem autoryzacyjnym (test i/lub
  prod) - patrz sekcja "Konfiguracja KSeF".
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

1. Zaloguj się do aplikacji KSeF (https://ksef.mf.gov.pl) swoim NIP-em.
2. W zakładce dot. tokenów wygeneruj **token autoryzacyjny** z uprawnieniem
   do odczytu/pobierania faktur.
3. Zapisz go w `.env` jako `KSEF_AUTH_TOKEN` (patrz `.env.example`).

⚠️ Token KSeF przestanie działać **31.12.2026** — Ministerstwo przechodzi na
uwierzytelnianie certyfikatem. Przed tą datą trzeba będzie zaktualizować
`src/ksefClient.js`, żeby używał certyfikatu (XAdES) zamiast tokenu.

## 1b. Generowanie PDF

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

## Możliwe rozszerzenia na później

- Przejście z tokenu na certyfikat przed końcem 2026.

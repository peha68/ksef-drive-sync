import { google } from 'googleapis';
import { config } from './config.js';
import { logger } from './logger.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

let driveInstance = null;

function getDrive() {
  if (driveInstance) return driveInstance;

  // OAuth 2.0 (nie service account - polityka organizacji blokowała
  // tworzenie kluczy JSON dla kont serwisowych). Uwierzytelnianie odbywa się
  // przez wcześniej wygenerowany refresh_token (patrz scripts/get-refresh-token.js
  // i README.md, sekcja "Autoryzacja Google Drive (OAuth)") - googleapis sam
  // odświeża access_token, gdy wygaśnie.
  const oauth2Client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oauth2Client.setCredentials({ refresh_token: config.google.refreshToken });

  driveInstance = google.drive({ version: 'v3', auth: oauth2Client });
  return driveInstance;
}

/**
 * Znajduje podfolder o danej nazwie w folderze `parentId`. Zwraca ID albo
 * `null`, jeśli nie istnieje - nie tworzy niczego.
 */
async function findFolder(parentId, name) {
  const drive = getDrive();

  const q = [
    `'${parentId}' in parents`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
  ].join(' and ');

  const existing = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  return existing.data.files?.length ? existing.data.files[0].id : null;
}

/**
 * Jak findFolder(), ale tworzy folder, jeśli nie istnieje. Zwraca ID folderu.
 */
async function findOrCreateFolder(parentId, name) {
  const drive = getDrive();

  const existingId = await findFolder(parentId, name);
  if (existingId) return existingId;

  logger.info(`Tworzę folder "${name}" na Dysku Google (rodzic: ${parentId})...`);
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    fields: 'id',
  });

  return created.data.id;
}

/**
 * Znajduje ID folderu <root>/<rok>/<miesiąc> bez go tworzyć. Zwraca `null`,
 * jeśli rok lub miesiąc jeszcze nie istnieje (np. brak faktur w danym
 * miesiącu).
 */
export async function findYearMonthFolder(year, month) {
  const monthPadded = String(month).padStart(2, '0');
  const yearFolderId = await findFolder(config.google.rootFolderId, String(year));
  if (!yearFolderId) return null;
  return findFolder(yearFolderId, monthPadded);
}

/**
 * Zapewnia istnienie ścieżki <root>/<rok>/<miesiąc> i zwraca ID folderu miesiąca.
 * Miesiąc jest zapisywany jako dwucyfrowy numer (01-12).
 */
export async function ensureYearMonthFolder(year, month) {
  const monthPadded = String(month).padStart(2, '0');
  const yearFolderId = await findOrCreateFolder(config.google.rootFolderId, String(year));
  const monthFolderId = await findOrCreateFolder(yearFolderId, monthPadded);
  return monthFolderId;
}

/**
 * Zapewnia istnienie podfolderu o danej nazwie bezpośrednio pod folderem
 * głównym (np. na archiwa ZIP za duże na załącznik e-mail). Zwraca jego ID.
 */
export async function ensureRootSubfolder(name) {
  return findOrCreateFolder(config.google.rootFolderId, name);
}

/**
 * Sprawdza, czy plik o danej nazwie już istnieje w folderze (zabezpieczenie
 * przed duplikatami przy wielokrotnym uruchomieniu skryptu na tym samym zakresie dat).
 */
export async function fileExistsInFolder(folderId, filename) {
  const drive = getDrive();
  const q = [
    `'${folderId}' in parents`,
    `name = '${filename.replace(/'/g, "\\'")}'`,
    'trashed = false',
  ].join(' and ');

  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  return Boolean(res.data.files?.length);
}

/**
 * Wgrywa plik (bufor) do wskazanego folderu na Dysku Google. Zwraca ID
 * utworzonego pliku.
 */
export async function uploadFile(folderId, filename, buffer, mimeType) {
  const drive = getDrive();
  const { Readable } = await import('node:stream');

  const created = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id',
  });

  logger.info(`Wgrano plik "${filename}" do folderu ${folderId}.`);
  return created.data.id;
}

/**
 * Zwraca listę {id, name} podfolderów bezpośrednio w danym folderze.
 */
export async function listSubfolders(parentId) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${parentId}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });
  return res.data.files ?? [];
}

/**
 * Zwraca listę {id, name, mimeType} plików (bez podfolderów) bezpośrednio w
 * danym folderze.
 */
export async function listFilesInFolder(folderId) {
  const drive = getDrive();
  const files = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
    });
    files.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Pobiera zawartość pliku jako Buffer.
 */
export async function downloadFileContent(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

/**
 * Ustawia plikowi uprawnienie "każdy z linkiem może wyświetlić" i zwraca
 * link do podglądu. Używane jako fallback, gdy załącznik ZIP jest za duży na
 * mail (odbiorca niekoniecznie ma konto Google, stąd "anyone", nie
 * udostępnianie po konkretnym adresie e-mail).
 */
export async function makeFilePublicAndGetLink(fileId) {
  const drive = getDrive();
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/**
 * Wysyłka maila z podsumowaniem synchronizacji przez Gmail API (ten sam
 * OAuth co Dysk - refresh token musi mieć dodatkowo zakres
 * https://www.googleapis.com/auth/gmail.send, patrz scripts/get-refresh-token.js).
 */
import { google } from 'googleapis';
import { config } from './config.js';

let gmailInstance = null;

function getGmail() {
  if (gmailInstance) return gmailInstance;

  const oauth2Client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oauth2Client.setCredentials({ refresh_token: config.google.refreshToken });

  gmailInstance = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmailInstance;
}

function encodeSubject(subject) {
  // Nagłówki maila muszą być ASCII - polskie znaki kodujemy przez RFC 2047.
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

function buildRawMessage({ to, subject, text, attachments = [] }) {
  const toHeader = Array.isArray(to) ? to.join(', ') : to;

  if (!attachments.length) {
    const message = [
      `To: ${toHeader}`,
      `Subject: ${encodeSubject(subject)}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      text,
    ].join('\r\n');
    return Buffer.from(message, 'utf-8').toString('base64url');
  }

  const boundary = `ksef_drive_sync_${Date.now()}`;
  const parts = [
    `To: ${toHeader}`,
    `Subject: ${encodeSubject(subject)}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
    '',
  ];

  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      att.content.toString('base64'),
      '',
    );
  }
  parts.push(`--${boundary}--`);

  return Buffer.from(parts.join('\r\n'), 'utf-8').toString('base64url');
}

/**
 * @param {{to: string|string[], subject: string, text: string, attachments?: Array<{filename: string, mimeType: string, content: Buffer}>}} options
 */
export async function sendMail({ to, subject, text, attachments }) {
  const gmail = getGmail();
  const raw = buildRawMessage({ to, subject, text, attachments });

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

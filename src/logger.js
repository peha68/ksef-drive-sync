import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    ensureDir(config.logFile);
    fs.appendFileSync(config.logFile, line + '\n');
  } catch (err) {
    console.error('Nie udało się zapisać logu do pliku:', err.message);
  }
}

export const logger = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
};

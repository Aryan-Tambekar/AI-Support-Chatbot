import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const logDirectory = path.resolve(serverDirectory, '..', 'logs');
const jsonLogPath = path.join(logDirectory, 'actions.jsonl');
const readableLogPath = path.join(logDirectory, 'actions.log');

fs.mkdirSync(logDirectory, { recursive: true });

export function audit(component, action, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    component,
    action,
    ...details,
  };

  fs.appendFileSync(jsonLogPath, `${JSON.stringify(entry)}\n`);
  fs.appendFileSync(readableLogPath, formatEntry(entry));
  console.log(JSON.stringify(entry));
}

function formatEntry(entry) {
  const details = Object.entries(entry)
    .filter(([key]) => !['timestamp', 'component', 'action'].includes(key))
    .map(([key, value]) => `  ${key}: ${String(value)}`)
    .join('\n');

  return `[${entry.timestamp}] ${entry.component.toUpperCase()} - ${entry.action}\n${details || '  No additional details'}\n\n`;
}

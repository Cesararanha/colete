import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.expo', { recursive: true });
await writeFile('.expo/staging-local.json', JSON.stringify({ origin: 'https://example.invalid' }));

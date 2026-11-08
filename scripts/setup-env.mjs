import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try {
  await access(new URL('../.env', import.meta.url));
  console.log('.env already exists; left unchanged.');
} catch {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  await writeFile(
    new URL('../.env', import.meta.url),
    example.replace('CREDENTIAL_KEY=\n', `CREDENTIAL_KEY=${randomBytes(32).toString('hex')}\n`),
    { mode: 0o600 },
  );
  console.log('Created .env with a random credential encryption key. Add your OpenAI API key.');
}

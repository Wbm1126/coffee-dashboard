import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';

const tempDirs: string[] = [];
afterEach(async () => Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('recovery API', () => {
  it('restores a validated backup through the HTTP boundary and returns to ready mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coffee-recovery-route-'));
    tempDirs.push(dataDir);
    const repository = new JsonRepository(dataDir);
    await repository.initialize();
    await repository.mutate(0, (data) => { data.preferenceProfile.brewMode = 'milk'; });
    const backup = await repository.backups.create('route-known-good');
    await writeFile(repository.dataFile, '{damaged', 'utf8');
    const app = await buildApp({ repository: new JsonRepository(dataDir), serveStatic: false, csrfToken: 'recovery-token' });

    expect((await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: '127.0.0.1:4173' } })).statusCode).toBe(503);
    const restored = await app.inject({
      method: 'POST', url: '/api/recovery/restore',
      headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'recovery-token' },
      payload: { backupName: backup.name },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ mode: 'ready', data: { dataRevision: 2, preferenceProfile: { brewMode: 'milk' } } });
    const snapshot = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: '127.0.0.1:4173' } });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ mode: 'ready', data: { preferenceProfile: { brewMode: 'milk' } } });
    await app.close();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { JsonRepository } from '../../src/storage/json-repository.js';
import { buildRepresentativeWorkbooks } from '../fixtures/import/build-workbooks.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('import API', () => {
  it('previews and commits a same-origin upload through the CSRF-protected API', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coffee-import-route-'));
    tempDirs.push(dataDir);
    const repository = new JsonRepository(dataDir);
    const app = await buildApp({ repository, serveStatic: false, csrfToken: 'import-token' });
    const files = await buildRepresentativeWorkbooks();
    const headers = {
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
      'x-csrf-token': 'import-token',
    };
    const previewResponse = await app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers,
      payload: {
        complete: { name: files.complete.name, base64: files.complete.bytes.toString('base64') },
        selection: { name: files.selection.name, base64: files.selection.bytes.toString('base64') },
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json();
    expect(preview).toMatchObject({ summary: { beans: 2, brands: 1 }, categories: { new: 2 } });

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/api/import/commit',
      headers,
      payload: {
        previewId: preview.id,
        expectedRevision: preview.baseRevision,
        resolutions: { [preview.conflicts[0].id]: 'complete' },
      },
    });
    expect(commitResponse.statusCode).toBe(200);
    expect(commitResponse.json()).toMatchObject({ dataRevision: 1, beans: 2, brands: 1 });
    await app.close();
  });

  it('rejects stale commits without writing and keeps another tab preview valid', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coffee-import-route-'));
    tempDirs.push(dataDir);
    const repository = new JsonRepository(dataDir);
    const app = await buildApp({ repository, serveStatic: false, csrfToken: 'import-token' });
    const files = await buildRepresentativeWorkbooks();
    const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'import-token' };
    const payload = {
      complete: { name: files.complete.name, base64: files.complete.bytes.toString('base64') },
      selection: { name: files.selection.name, base64: files.selection.bytes.toString('base64') },
    };
    const first = (await app.inject({ method: 'POST', url: '/api/import/preview', headers, payload })).json();
    const second = (await app.inject({ method: 'POST', url: '/api/import/preview', headers, payload })).json();
    await repository.mutate(0, () => undefined);
    const stale = await app.inject({
      method: 'POST', url: '/api/import/commit', headers,
      payload: { previewId: first.id, expectedRevision: first.baseRevision, resolutions: Object.fromEntries(first.conflicts.map((conflict: { id: string; availableChoices: string[] }) => [conflict.id, conflict.availableChoices[0]])) },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'revision_conflict' });
    expect((await repository.read()).importBatches).toHaveLength(0);

    const secondCommit = await app.inject({
      method: 'POST', url: '/api/import/commit', headers,
      payload: { previewId: second.id, expectedRevision: second.baseRevision, resolutions: Object.fromEntries(second.conflicts.map((conflict: { id: string; availableChoices: string[] }) => [conflict.id, conflict.availableChoices[0]])) },
    });
    expect(secondCommit.statusCode).toBe(409);
    expect(secondCommit.json()).toMatchObject({ error: 'revision_conflict' });

    const expired = await app.inject({
      method: 'POST', url: '/api/import/commit', headers,
      payload: { previewId: '0'.repeat(64), expectedRevision: 1, resolutions: {} },
    });
    expect(expired.statusCode).toBe(410);
    await app.close();
  });

  it('does not invalidate a previous preview when another tab generates one', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coffee-import-route-'));
    tempDirs.push(dataDir);
    const repository = new JsonRepository(dataDir);
    const app = await buildApp({ repository, serveStatic: false, csrfToken: 'import-token' });
    const files = await buildRepresentativeWorkbooks();
    const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-csrf-token': 'import-token' };
    const payload = { complete: { name: files.complete.name, base64: files.complete.bytes.toString('base64') }, selection: { name: files.selection.name, base64: files.selection.bytes.toString('base64') } };
    const first = (await app.inject({ method: 'POST', url: '/api/import/preview', headers, payload })).json();
    await app.inject({ method: 'POST', url: '/api/import/preview', headers, payload });
    const committed = await app.inject({
      method: 'POST', url: '/api/import/commit', headers,
      payload: { previewId: first.id, expectedRevision: first.baseRevision, resolutions: Object.fromEntries(first.conflicts.map((conflict: { id: string; availableChoices: string[] }) => [conflict.id, conflict.availableChoices[0]])) },
    });
    expect(committed.statusCode).toBe(200);
    await app.close();
  });
});

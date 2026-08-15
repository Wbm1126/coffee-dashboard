import { randomUUID } from 'node:crypto';
import { normalizeBeanIdentity } from './bean-identity.js';
import type { CoffeeData } from './schema.js';

export function findOrCreateActiveBrand(data: CoffeeData, name: string, now: string): CoffeeData['brands'][number] {
  const normalized = normalizeBeanIdentity(name);
  let brand = data.brands.find((candidate) => !candidate.archivedAt
    && [candidate.name, ...candidate.aliases].some((alias) => normalizeBeanIdentity(alias) === normalized));
  if (!brand) {
    brand = { id: randomUUID(), name, aliases: [], archivedAt: null, createdAt: now, updatedAt: now };
    data.brands.push(brand);
  }
  return brand;
}

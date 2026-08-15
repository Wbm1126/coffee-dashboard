import { hash } from 'node:crypto';

export function sha256(bytes: Uint8Array): string {
  return hash('sha256', bytes, 'hex');
}

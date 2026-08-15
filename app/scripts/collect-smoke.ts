import { createCollectionService } from '../src/collectors/service.js';

const query = process.argv.slice(2).join(' ').trim() || 'coffee beans';

try {
  const candidates = await createCollectionService().search(query);
  if (!candidates.length) throw new Error('provider returned no candidates');
  console.log(`DuckDuckGo HTML provider returned ${candidates.length} candidates for the controlled query.`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown collector failure';
  console.error(`Collector smoke check failed: ${message}`);
  console.error('No local coffee data was sent. Check direct public DNS/connectivity, then retry this command.');
  process.exitCode = 1;
}

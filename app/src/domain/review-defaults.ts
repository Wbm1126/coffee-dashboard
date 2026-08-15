import type { Review } from './schema.js';

export function createUnreviewedReview(): Review {
  return {
    state: 'unreviewed',
    score: null,
    flavorNotes: [],
    pros: null,
    cons: null,
    note: null,
  };
}

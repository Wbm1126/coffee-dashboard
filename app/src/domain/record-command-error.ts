export type RecordCommandCode =
  | 'assessment_basis_conflict'
  | 'already_in_trash'
  | 'bean_not_found'
  | 'drinking_record_not_found'
  | 'not_in_trash'
  | 'permanent_clear_requires_trashed_record'
  | 'purchase_item_bean_mismatch'
  | 'purchase_item_not_found'
  | 'purchase_item_referenced'
  | 'purchase_not_found'
  | 'restore_conflict';

export const RECORD_NOT_FOUND_CODES = new Set<RecordCommandCode>([
  'bean_not_found',
  'drinking_record_not_found',
  'purchase_item_not_found',
  'purchase_not_found',
]);

export class RecordCommandError extends Error {
  constructor(readonly code: RecordCommandCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'RecordCommandError';
  }
}

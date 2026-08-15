import { z } from 'zod';

export const ImportConflictChoiceSchema = z.enum(['complete', 'selection', 'existing']);
export type ImportConflictChoice = z.infer<typeof ImportConflictChoiceSchema>;

import { z } from 'zod';

// incoming：通用表格导入（单文件）冲突中的「本行值」；complete/selection 是成对工作簿兼容模式的历史选项。
export const ImportConflictChoiceSchema = z.enum(['complete', 'selection', 'existing', 'incoming']);
export type ImportConflictChoice = z.infer<typeof ImportConflictChoiceSchema>;

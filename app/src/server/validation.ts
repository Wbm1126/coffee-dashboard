import { z } from 'zod';

export const optionalText = (max: number) => z
  .string()
  .trim()
  .max(max)
  .nullable()
  .optional()
  .transform((value) => value || null);

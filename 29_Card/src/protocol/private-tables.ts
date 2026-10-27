import { z } from 'zod';

export const tablePinSchema = z.string().regex(/^\d{6}$/);
export const joinAttemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const createTableRequestSchema = z.strictObject({});
export const joinTableRequestSchema = z.strictObject({ pin: tablePinSchema, attemptId: joinAttemptIdSchema });
export const tableCredentialsSchema = z.strictObject({
  pin: tablePinSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const tableErrorSchema = z.strictObject({ error: z.string().min(1).max(128) });
export type TableCredentials = z.infer<typeof tableCredentialsSchema>;
export type JoinTableRequest = z.infer<typeof joinTableRequestSchema>;

import { z } from 'zod';

export const LiaraDecryptedCredentialSchema = z
  .object({
    apiKey: z
      .string()
      .min(1, 'apiKey must not be empty')
      .max(1024, 'apiKey exceeds maximum length'),
    teamId: z
      .string()
      .min(1, 'teamId must not be empty')
      .max(128, 'teamId exceeds maximum length')
      .optional(),
  })
  .strict();

export type LiaraDecryptedCredential = z.infer<typeof LiaraDecryptedCredentialSchema>;

export interface ParsedLiaraCredential {
  apiKey: string;
  teamId?: string;
  sensitiveTokens: string[];
}

/**
 * Decodes Liara credential plaintext from decrypted envelope.
 *
 * Supports:
 * - Strict JSON payload { apiKey, teamId? } when starting with '{' (strict schema, no unknown fields).
 * - Legacy bare string API token when not starting with '{'.
 *
 * Appends both full JSON plaintext and bare apiKey token to sensitiveTokens for complete redaction.
 */
export function parseLiaraDecryptedCredential(decryptedPlaintext: string): ParsedLiaraCredential {
  const trimmed = decryptedPlaintext.trim();
  if (trimmed.startsWith('{')) {
    const rawJson = JSON.parse(trimmed);
    const validated = LiaraDecryptedCredentialSchema.parse(rawJson);
    const sensitiveTokens = [trimmed, validated.apiKey];
    return {
      apiKey: validated.apiKey,
      teamId: validated.teamId,
      sensitiveTokens,
    };
  }

  // Bare token legacy format
  if (!trimmed) {
    throw new Error('Liara credential plaintext is empty');
  }

  return {
    apiKey: trimmed,
    teamId: undefined,
    sensitiveTokens: [trimmed],
  };
}

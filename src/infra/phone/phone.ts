import { BadRequestException } from '@nestjs/common';

/**
 * Phone-number handling.
 *
 * Lives in `infra` rather than in the auth module because the rate-limit guard
 * needs the same normalization: a per-phone limit keyed on the raw request body
 * would count `+998901234567` and `998 90 123 45 67` as two different subjects,
 * and the limit would be bypassed by reformatting.
 */

/**
 * Normalizes a phone number to E.164-ish digits with a leading `+`.
 *
 * Deliberately minimal: the spec does not restrict country, and a permissive
 * normalizer that only strips formatting is safer than a strict parser that
 * silently rejects a valid number and locks a real user out of registration.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');

  if (digits.length < 9 || digits.length > 15) {
    throw new BadRequestException('phone must contain 9 to 15 digits');
  }

  return `+${digits}`;
}

/** Last two digits only - never log a full phone number (§12.1). */
export function maskPhone(phone: string): string {
  return `***${phone.slice(-2)}`;
}

import { HttpException, HttpStatus } from '@nestjs/common';
import type { ValidationError } from '@nestjs/common';

import type { MessageKey, MessageParams } from '@infra/i18n/messages';

/** One rejected field, ready to be localized (docs/API_CONTRACTS.md §4.6). */
export interface FieldViolation {
  /** Field path, dotted for nested objects: `salary.from`. */
  field: string;
  /** The rule that rejected it, e.g. `maxLength` - stable, never translated. */
  rule: string;
  messageKey: MessageKey;
  params?: MessageParams;
}

/**
 * A failed request-body validation, carrying structured violations rather than
 * rendered text.
 *
 * §3.2 requires validation messages in all four interface variants, but
 * `ValidationPipe`'s `exceptionFactory` never sees the request and so cannot know
 * the caller's locale. It therefore produces this, and `ApiExceptionFilter`
 * renders it once the locale is known.
 *
 * 422 rather than 400: the request was well-formed and understood, its contents
 * were unacceptable. The contract's error example (§4.6) is a 422.
 */
export class ValidationFailedException extends HttpException {
  constructor(readonly violations: FieldViolation[]) {
    super('validation.failed', HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/**
 * class-validator constraint name → catalog key.
 *
 * Only the constraints actually used in this codebase are mapped; anything else
 * falls back to a generic "value not allowed", which is still localized. The
 * alternative - passing class-validator's own English text through - would leave
 * exactly the messages §3.2 names as needing translation untranslated.
 */
const RULE_MESSAGES: Record<string, MessageKey> = {
  isDefined: 'validation.required',
  isNotEmpty: 'validation.required',
  whitelistValidation: 'validation.unknown_field',
  isString: 'validation.must_be_text',
  isNumber: 'validation.must_be_number',
  isInt: 'validation.must_be_integer',
  isBoolean: 'validation.must_be_boolean',
  isDateString: 'validation.must_be_date',
  isDate: 'validation.must_be_date',
  isArray: 'validation.must_be_list',
  arrayNotEmpty: 'validation.list_empty',
  isUuid: 'validation.must_be_id',
  isIn: 'validation.not_allowed_value',
  isEnum: 'validation.not_allowed_value',
  minLength: 'validation.too_short',
  maxLength: 'validation.too_long',
  min: 'validation.too_small',
  max: 'validation.too_big',
};

/**
 * Flattens class-validator's nested errors into localizable violations.
 *
 * The numeric bound in `too_long` and friends is recovered from the constraint's
 * own English text, which is the only place `ValidationPipe` exposes it. If the
 * wording ever changes upstream the number is simply omitted and the message
 * degrades to its unparameterized form - never to a broken sentence.
 */
export function toViolations(
  errors: ValidationError[],
  parentPath = '',
): FieldViolation[] {
  const violations: FieldViolation[] = [];

  for (const error of errors) {
    const field = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;

    for (const [rule, text] of Object.entries(error.constraints ?? {})) {
      violations.push({
        field,
        rule,
        messageKey: RULE_MESSAGES[rule] ?? 'validation.not_allowed_value',
        params: boundFrom(rule, text),
      });
    }

    if (error.children && error.children.length > 0) {
      violations.push(...toViolations(error.children, field));
    }
  }

  return violations;
}

function boundFrom(
  rule: string,
  text: string | undefined,
): MessageParams | undefined {
  const number = text?.match(/-?\d+/)?.[0];

  if (!number) {
    return undefined;
  }

  switch (rule) {
    case 'minLength':
      return { min: number };
    case 'maxLength':
      return { max: number };
    case 'min':
      return { min: number };
    case 'max':
      return { max: number };
    default:
      return undefined;
  }
}

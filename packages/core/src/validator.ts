/**
 * Tina4 Validator — Request body validation.
 *
 * Usage:
 *   import { Validator } from "@tina4/core";
 *
 *   const validator = new Validator(req.body as Record<string, unknown>);
 *   validator.required("name", "email");
 *   validator.email("email");
 *   validator.minLength("name", 2);
 *   validator.maxLength("name", 100);
 *   validator.integer("age");
 *   validator.min("age", 0);
 *   validator.max("age", 150);
 *   validator.inList("role", ["admin", "user", "guest"]);
 *   validator.regex("phone", /^\+?[\d\s\-]+$/);
 *
 *   if (!validator.isValid()) {
 *     return res.error("VALIDATION_FAILED", validator.errors()[0].message, 400);
 *   }
 */

export interface ValidationError {
  field: string;
  message: string;
}

const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

export class Validator {
  private data: Record<string, unknown>;
  private validationErrors: ValidationError[] = [];

  constructor(data?: Record<string, unknown> | null) {
    this.data = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {};
  }

  /** Check that one or more fields are present and non-empty. */
  required(...fields: string[]): this {
    for (const field of fields) {
      const value = this.data[field];
      if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        this.validationErrors.push({ field, message: `${field} is required` });
      }
    }
    return this;
  }

  /** Check that a field contains a valid email address. */
  email(field: string): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    if (typeof value !== "string" || !EMAIL_REGEX.test(value)) {
      this.validationErrors.push({ field, message: `${field} must be a valid email address` });
    }
    return this;
  }

  /** Check that a string field has at least `length` characters. */
  minLength(field: string, length: number): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    if (typeof value !== "string" || value.length < length) {
      this.validationErrors.push({ field, message: `${field} must be at least ${length} characters` });
    }
    return this;
  }

  /** Check that a string field has at most `length` characters. */
  maxLength(field: string, length: number): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    if (typeof value !== "string" || value.length > length) {
      this.validationErrors.push({ field, message: `${field} must be at most ${length} characters` });
    }
    return this;
  }

  /** Check that a field is an integer (or can be parsed as one). */
  integer(field: string): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    if (typeof value === "boolean" || !Number.isInteger(Number(value)) || String(value).trim() === "") {
      this.validationErrors.push({ field, message: `${field} must be an integer` });
    }
    return this;
  }

  /** Check that a numeric field is >= `minimum`. */
  min(field: string, minimum: number): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    const num = Number(value);
    if (isNaN(num)) return this;
    if (num < minimum) {
      this.validationErrors.push({ field, message: `${field} must be at least ${minimum}` });
    }
    return this;
  }

  /** Check that a numeric field is <= `maximum`. */
  max(field: string, maximum: number): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    const num = Number(value);
    if (isNaN(num)) return this;
    if (num > maximum) {
      this.validationErrors.push({ field, message: `${field} must be at most ${maximum}` });
    }
    return this;
  }

  /** Check that a field's value is one of the allowed values. */
  inList(field: string, allowed: unknown[]): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    if (!allowed.includes(value)) {
      this.validationErrors.push({ field, message: `${field} must be one of ${JSON.stringify(allowed)}` });
    }
    return this;
  }

  /** Check that a field matches a regular expression. */
  regex(field: string, pattern: RegExp | string): this {
    const value = this.data[field];
    if (value === undefined || value === null) return this;
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    if (typeof value !== "string" || !re.test(value)) {
      this.validationErrors.push({ field, message: `${field} does not match the required format` });
    }
    return this;
  }

  /** Return the list of validation errors (empty if valid). */
  errors(): ValidationError[] {
    return [...this.validationErrors];
  }

  /** Return true if no validation errors have been recorded. */
  isValid(): boolean {
    return this.validationErrors.length === 0;
  }
}

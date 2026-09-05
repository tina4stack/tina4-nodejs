import type { FieldDefinition } from "./types.js";

export interface ValidationError {
  field: string;
  message: string;
}

function error(field: string, message: string): ValidationError {
  return { field, message };
}

function validateString(
  name: string,
  value: string,
  def: FieldDefinition,
  pattern: RegExp | undefined,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (def.minLength !== undefined && value.length < def.minLength) {
    errors.push(error(name, `must be at least ${def.minLength} characters`));
  }
  if (def.maxLength !== undefined && value.length > def.maxLength) {
    errors.push(error(name, `must be at most ${def.maxLength} characters`));
  }
  if (pattern && !pattern.test(value)) {
    errors.push(error(name, "does not match the required format"));
  }
  return errors;
}

function validateNumber(name: string, value: unknown, def: FieldDefinition): ValidationError[] {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || isNaN(num)) return [error(name, "must be a number")];

  const errors: ValidationError[] = [];
  if (def.type === "integer" && !Number.isInteger(num)) {
    errors.push(error(name, "must be an integer"));
  }
  if (def.min !== undefined && num < def.min) {
    errors.push(error(name, `must be at least ${def.min}`));
  }
  if (def.max !== undefined && num > def.max) {
    errors.push(error(name, `must be at most ${def.max}`));
  }
  return errors;
}

function validateField(
  name: string,
  value: unknown,
  def: FieldDefinition,
  pattern: RegExp | undefined,
): ValidationError[] {
  if (def.type === "string" || def.type === "text") {
    return typeof value === "string"
      ? validateString(name, value, def, pattern)
      : [error(name, "must be a string")];
  }

  if (def.type === "integer" || def.type === "number" || def.type === "numeric") {
    return validateNumber(name, value, def);
  }

  switch (def.type) {
    case "boolean":
      return typeof value === "boolean" || value === 0 || value === 1 || value === "true" || value === "false"
        ? []
        : [error(name, "must be a boolean")];
    case "datetime":
      return typeof value === "string" && isNaN(Date.parse(value))
        ? [error(name, "must be a valid date/time")]
        : [];
    case "json":
      return value !== null && typeof value !== "object" && typeof value !== "string"
        ? [error(name, "must be a JSON object or array")]
        : [];
    case "foreignKey": {
      const fkNum = typeof value === "string" ? Number(value) : value;
      return typeof fkNum !== "number" || isNaN(fkNum) || !Number.isInteger(fkNum)
        ? [error(name, "must be a valid foreign key (integer)")]
        : [];
    }
    default:
      return [];
  }
}

export function validate(
  data: Record<string, unknown>,
  fields: Record<string, FieldDefinition>,
  isUpdate = false
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Pre-compile regex patterns outside the loop (E005)
  const compiledPatterns = new Map<string, RegExp>();
  for (const [name, def] of Object.entries(fields)) {
    if (def.pattern !== undefined) {
      compiledPatterns.set(name, new RegExp(def.pattern));
    }
  }

  for (const [name, def] of Object.entries(fields)) {
    // Skip primary key / autoIncrement fields on create
    if (def.primaryKey && def.autoIncrement) continue;

    const value = data[name];

    // Required check (skip on update if field not provided)
    if (def.required && !isUpdate && (value === undefined || value === null || value === "")) {
      errors.push(error(name, "is required"));
      continue;
    }

    // Skip further validation if value not provided
    if (value === undefined || value === null) continue;

    errors.push(...validateField(name, value, def, compiledPatterns.get(name)));
  }

  return errors;
}

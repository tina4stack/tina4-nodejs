import type { FieldDefinition } from "./types.js";

export interface ValidationError {
  field: string;
  message: string;
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
      errors.push({ field: name, message: "is required" });
      continue;
    }

    // Skip further validation if value not provided
    if (value === undefined || value === null) continue;

    // Type checks
    switch (def.type) {
      case "string":
      case "text":
        if (typeof value !== "string") {
          errors.push({ field: name, message: "must be a string" });
        } else {
          if (def.minLength !== undefined && value.length < def.minLength) {
            errors.push({ field: name, message: `must be at least ${def.minLength} characters` });
          }
          if (def.maxLength !== undefined && value.length > def.maxLength) {
            errors.push({ field: name, message: `must be at most ${def.maxLength} characters` });
          }
          const regex = compiledPatterns.get(name);
          if (regex && !regex.test(value)) {
            errors.push({ field: name, message: `does not match required pattern` });
          }
        }
        break;

      case "integer":
      case "number":
      case "numeric": {
        const num = typeof value === "string" ? Number(value) : value;
        if (typeof num !== "number" || isNaN(num)) {
          errors.push({ field: name, message: "must be a number" });
        } else {
          if (def.type === "integer" && !Number.isInteger(num)) {
            errors.push({ field: name, message: "must be an integer" });
          }
          if (def.min !== undefined && num < def.min) {
            errors.push({ field: name, message: `must be at least ${def.min}` });
          }
          if (def.max !== undefined && num > def.max) {
            errors.push({ field: name, message: `must be at most ${def.max}` });
          }
        }
        break;
      }

      case "boolean":
        if (typeof value !== "boolean" && value !== 0 && value !== 1 && value !== "true" && value !== "false") {
          errors.push({ field: name, message: "must be a boolean" });
        }
        break;

      case "datetime":
        if (typeof value === "string" && isNaN(Date.parse(value))) {
          errors.push({ field: name, message: "must be a valid date/time" });
        }
        break;
    }
  }

  return errors;
}

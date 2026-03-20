// Tina4 ORM FakeData — extends core FakeData with ORM-aware data generation.
// Re-exports core FakeData with additional forField() for auto-generating
// data based on ORM field definitions.

import { FakeData as CoreFakeData } from "../../core/src/fakeData.js";
import type { FieldDefinition } from "./types.js";

/**
 * ORM-aware FakeData — wraps the core FakeData and adds forField()
 * which generates appropriate fake data based on an ORM FieldDefinition.
 */
export class FakeData extends CoreFakeData {
  constructor(seed?: number) {
    super(seed);
  }

  /** Alias for fullName() to match the Python API. */
  name(): string {
    return this.fullName();
  }

  /** Alias for float() to match the Python API. */
  numeric(min = 0, max = 1000, decimals = 2): number {
    return this.float(min, max, decimals);
  }

  /**
   * Generate a Date object within a year range.
   * Matches the Python API's datetime() method.
   */
  datetime(startYear = 2020, endYear = 2025): Date {
    const startMs = new Date(startYear, 0, 1).getTime();
    const endMs = new Date(endYear, 11, 31, 23, 59, 59).getTime();
    const diffDays = Math.floor((endMs - startMs) / 86400000);
    const offset = this.integer(0, diffDays);
    return new Date(startMs + offset * 86400000);
  }

  /**
   * Generate a fake value appropriate for an ORM field definition.
   * Respects min/max, minLength/maxLength, and type constraints.
   *
   * @param fieldDef - An ORM FieldDefinition object
   * @param columnName - Optional column name for heuristic matching (e.g. "email", "phone")
   */
  forField(fieldDef: FieldDefinition, columnName?: string): unknown {
    // Auto-increment primary keys should not be generated
    if (fieldDef.primaryKey && fieldDef.autoIncrement) {
      return undefined;
    }

    // If there's a default, use it sometimes (but not always for variety)
    if (fieldDef.default !== undefined) {
      return fieldDef.default;
    }

    // Heuristic: use column name to pick a smarter generator
    const col = (columnName ?? "").toLowerCase();

    if (col.includes("email")) return this.email();
    if (col.includes("phone") || col.includes("mobile") || col.includes("tel")) return this.phone();
    if (col === "name" || col === "full_name" || col === "fullname") return this.name();
    if (col === "first_name" || col === "firstname") return this.firstName();
    if (col === "last_name" || col === "lastname" || col === "surname") return this.lastName();
    if (col.includes("address")) return this.address();
    if (col.includes("city")) return this.city();
    if (col.includes("country")) return this.country();
    if (col.includes("zip") || col.includes("postal")) return this.zipCode();
    if (col.includes("company") || col.includes("org")) return this.company();
    if (col.includes("job") || col.includes("title") || col.includes("position")) return this.jobTitle();
    if (col.includes("url") || col.includes("website") || col.includes("link")) return this.url();
    if (col.includes("color") || col.includes("colour")) return this.hexColor();
    if (col.includes("uuid") || col === "guid") return this.uuid();
    if (col === "ip" || col === "ip_address" || col === "ipaddress") return this.ipAddress();
    if (col.includes("currency")) return this.currency();

    // Fall back to type-based generation
    switch (fieldDef.type) {
      case "string": {
        const maxLen = fieldDef.maxLength ?? 50;
        const minLen = fieldDef.minLength ?? 3;
        // Generate a sentence and trim to fit
        let value = this.sentence(Math.max(2, Math.ceil(maxLen / 6)));
        if (value.length > maxLen) value = value.slice(0, maxLen);
        if (value.length < minLen) {
          while (value.length < minLen) value += " " + this.word();
          value = value.slice(0, maxLen);
        }
        return value;
      }

      case "text":
        return this.paragraph(3);

      case "integer": {
        const min = (fieldDef.min as number) ?? 0;
        const max = (fieldDef.max as number) ?? 10000;
        return this.integer(min, max);
      }

      case "number": {
        const min = (fieldDef.min as number) ?? 0;
        const max = (fieldDef.max as number) ?? 10000;
        return this.numeric(min, max, 2);
      }

      case "boolean":
        return this.boolean();

      case "datetime":
        return this.datetime().toISOString();

      default:
        return this.sentence(4);
    }
  }
}

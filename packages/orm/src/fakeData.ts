// Tina4 ORM FakeData — extends core FakeData with ORM-aware data generation.
// Re-exports core FakeData with additional forField() for auto-generating
// data based on ORM field definitions.

import { FakeData as CoreFakeData } from "../../core/src/fakeData.js";
import type { FieldDefinition } from "./types.js";

// A table/model whose name contains any of these gets product names on its
// generic `name`/`full_name` column instead of a person name. Mirrors the
// Python master's `_PRODUCT_TABLE_HINTS`.
const PRODUCT_TABLE_HINTS = [
  "product", "item", "catalog", "inventory", "goods", "merchandise",
  "sku", "listing", "stock", "ware",
] as const;

const COLUMN_HEURISTICS: Array<[RegExp, string]> = [
  [/email/, "email"],
  [/(phone|mobile|tel)/, "phone"],
  [/^(name|full_name|fullname)$/, "name"],
  [/^(first_name|firstname)$/, "firstName"],
  [/^(last_name|lastname|surname)$/, "lastName"],
  [/address/, "address"],
  [/city/, "city"],
  [/country/, "country"],
  [/(zip|postal)/, "zipCode"],
  [/(company|org)/, "company"],
  [/(job|title|position)/, "jobTitle"],
  [/(url|website|link)/, "url"],
  [/(color|colour)/, "colorHex"],
  [/(uuid|guid)/, "uuid"],
  [/^(ip|ip_address|ipaddress)$/, "ipAddress"],
  [/currency/, "currency"],
];

const HEURISTIC_METHODS: Record<string, string> = {
  email: "email",
  phone: "phone",
  firstName: "firstName",
  lastName: "lastName",
  address: "address",
  city: "city",
  country: "country",
  zipCode: "zipCode",
  company: "company",
  jobTitle: "jobTitle",
  url: "url",
  colorHex: "colorHex",
  uuid: "uuid",
  ipAddress: "ipAddress",
  currency: "currency",
};

/**
 * True when the table/model name looks like a product catalogue, so a generic
 * `name` column should seed a product name, not a person name. With NO table
 * context (undefined/null/empty) this is false, so the person-name default is
 * kept — back-compat. Exported (not via the barrel) so seeding tests can assert
 * it directly, mirroring the Python master's `_is_product_table`.
 */
export function isProductTable(table?: string | null): boolean {
  const t = (table ?? "").toLowerCase();
  return PRODUCT_TABLE_HINTS.some((hint) => t.includes(hint));
}

/**
 * ORM-aware FakeData — wraps the core FakeData and adds forField()
 * which generates appropriate fake data based on an ORM FieldDefinition.
 */
export class FakeData extends CoreFakeData {
  constructor(seed?: number) {
    super(seed);
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

  private heuristicValue(key: string, table?: string): unknown {
    if (key === "name") return isProductTable(table) ? this.product() : this.name();
    const methodName = HEURISTIC_METHODS[key];
    const method = methodName
      ? (this as unknown as Record<string, unknown>)[methodName]
      : undefined;
    return typeof method === "function" ? method.call(this) : undefined;
  }

  private stringValue(fieldDef: FieldDefinition): string {
    const maxLen = fieldDef.maxLength ?? 50;
    const minLen = fieldDef.minLength ?? 3;
    let value = this.sentence(Math.max(2, Math.ceil(maxLen / 6)));
    if (value.length > maxLen) value = value.slice(0, maxLen);
    if (value.length < minLen) {
      while (value.length < minLen) value += " " + this.word();
      value = value.slice(0, maxLen);
    }
    return value;
  }

  private typedValue(fieldDef: FieldDefinition): unknown {
    if (fieldDef.type === "string") return this.stringValue(fieldDef);
    if (fieldDef.type === "text") return this.paragraph(3);
    if (fieldDef.type === "integer") return this.integer(fieldDef.min ?? 0, fieldDef.max ?? 10000);
    if (fieldDef.type === "number" || fieldDef.type === "numeric") {
      return this.numeric(fieldDef.min ?? 0, fieldDef.max ?? 10000, 2);
    }
    if (fieldDef.type === "boolean") return this.boolean();
    if (fieldDef.type === "datetime") return this.datetime().toISOString();
    return this.sentence(4);
  }

  /**
   * Generate a fake value appropriate for an ORM field definition.
   * Respects min/max, minLength/maxLength, and type constraints.
   *
   * @param fieldDef - An ORM FieldDefinition object
   * @param columnName - Optional column name for heuristic matching (e.g. "email", "phone")
   * @param table - Optional table/model name. A generic `name`/`full_name`
   *   column on a product-ish table (see {@link isProductTable}) gets a
   *   product name; with no table context it stays a person name (back-compat).
   */
  forField(fieldDef: FieldDefinition, columnName?: string, table?: string): unknown {
    // Auto-increment primary keys should not be generated
    if (fieldDef.primaryKey && fieldDef.autoIncrement) {
      return undefined;
    }

    // If there's a default, use it SOME of the time (SEED-NODE-DEFAULT fix) so
    // a defaulted field still gets varied fakes across a seeded batch instead
    // of the identical value on every row. This coin-flip reads from the same
    // instance PRNG as every other generator, so it stays reproducible under
    // a seed.
    if (fieldDef.default !== undefined && this.boolean()) {
      return fieldDef.default;
    }

    const col = (columnName ?? "").toLowerCase();
    const heuristic = COLUMN_HEURISTICS.find(([pattern]) => pattern.test(col));
    if (heuristic) return this.heuristicValue(heuristic[1], table);
    return this.typedValue(fieldDef);
  }
}

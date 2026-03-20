// Tina4 FakeData — Fake data generation and database seeding, zero dependencies.
// Instance-based with optional seeded PRNG for deterministic output.

import { randomInt, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Word Banks ───────────────────────────────────────────────────

const FIRST_NAMES = [
  "Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Henry",
  "Ivy", "Jack", "Kate", "Leo", "Mia", "Noah", "Olivia", "Pete",
  "Quinn", "Rose", "Sam", "Tina", "Uma", "Vince", "Wendy", "Xander",
  "Yara", "Zane", "Anna", "Ben", "Chloe", "Dan", "Emma", "Felix",
  "Gina", "Hugo", "Iris", "Jake", "Lily", "Max", "Nora", "Oscar",
  "Penny", "Ray", "Sara", "Tom", "Vera", "Will", "Xena", "Yves",
  "Zara", "Amber", "Blake", "Clara",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson",
  "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee",
  "Perez", "Thompson", "White", "Harris", "Clark", "Lewis", "Young",
  "Walker", "Hall", "Allen", "King", "Wright", "Scott", "Green",
  "Adams", "Baker", "Nelson", "Carter", "Mitchell", "Roberts", "Turner",
  "Phillips", "Campbell", "Parker", "Evans", "Edwards", "Collins",
  "Stewart", "Morris", "Murphy", "Cook",
];

const DOMAINS = ["example.com", "test.org", "demo.net", "mail.dev", "inbox.io"];

const WORDS = [
  "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
  "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore",
  "magna", "aliqua", "enim", "minim", "veniam", "quis", "nostrud",
  "exercitation", "ullamco", "laboris", "nisi", "aliquip", "commodo",
  "consequat", "duis", "aute", "irure", "reprehenderit", "voluptate",
];

const CITIES = [
  "New York", "London", "Tokyo", "Paris", "Sydney", "Berlin", "Toronto",
  "Cape Town", "Mumbai", "Singapore", "Dubai", "Amsterdam", "Seoul",
  "Barcelona", "Melbourne", "Stockholm", "Vienna", "Zurich", "Oslo",
  "Helsinki", "Prague", "Warsaw", "Dublin", "Brussels", "Lisbon",
];

const COUNTRIES = [
  "United States", "United Kingdom", "Japan", "France", "Australia",
  "Germany", "Canada", "South Africa", "India", "Singapore", "UAE",
  "Netherlands", "South Korea", "Spain", "Brazil", "Italy", "Mexico",
  "Sweden", "Switzerland", "Norway",
];

const STREETS = [
  "Main St", "Oak Ave", "Park Rd", "Cedar Ln", "Elm St", "Pine Dr",
  "Maple Way", "River Rd", "Lake Blvd", "Hill Ct", "Valley View",
  "Sunset Blvd", "Broadway", "Church St", "Mill Rd",
];

const JOB_TITLES = [
  "Software Engineer", "Product Manager", "Data Analyst", "Designer",
  "DevOps Engineer", "QA Engineer", "Project Manager", "CTO",
  "Marketing Manager", "Sales Director", "HR Manager", "Accountant",
  "Consultant", "Architect", "Team Lead", "VP Engineering",
  "Frontend Developer", "Backend Developer", "Full Stack Developer",
  "Systems Administrator",
];

const COLORS = [
  "red", "blue", "green", "yellow", "purple", "orange", "pink",
  "cyan", "magenta", "teal", "indigo", "violet", "coral", "salmon",
  "turquoise", "maroon", "navy", "olive", "silver", "gold",
];

const CURRENCIES = [
  "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY",
  "SEK", "NZD", "MXN", "SGD", "HKD", "NOK", "ZAR", "INR",
];

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────

/**
 * Mulberry32: a simple 32-bit seeded PRNG.
 * Returns a function that produces values in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── FakeData Class ───────────────────────────────────────────────

export class FakeData {
  private rng: () => number;
  private seeded: boolean;

  constructor(seed?: number) {
    if (seed !== undefined) {
      this.rng = mulberry32(seed);
      this.seeded = true;
    } else {
      this.rng = Math.random;
      this.seeded = false;
    }
  }

  /** Static factory — create a seeded FakeData instance. */
  static seed(seed: number): FakeData {
    return new FakeData(seed);
  }

  /** Returns a random integer in [min, max) using the instance PRNG. */
  private randInt(min: number, max: number): number {
    if (this.seeded) {
      return min + Math.floor(this.rng() * (max - min));
    }
    return randomInt(min, max);
  }

  /** Pick a random element from an array. */
  private pick<T>(arr: readonly T[]): T {
    return arr[this.randInt(0, arr.length)];
  }

  firstName(): string {
    return this.pick(FIRST_NAMES);
  }

  lastName(): string {
    return this.pick(LAST_NAMES);
  }

  fullName(): string {
    return `${this.firstName()} ${this.lastName()}`;
  }

  email(): string {
    const first = this.firstName().toLowerCase();
    const last = this.lastName().toLowerCase();
    const domain = this.pick(DOMAINS);
    return `${first}.${last}@${domain}`;
  }

  phone(): string {
    const area = this.randInt(200, 1000);
    const mid = this.randInt(100, 1000);
    const end = this.randInt(1000, 10000);
    return `+1 (${area}) ${mid}-${end}`;
  }

  address(): string {
    const num = this.randInt(1, 1000);
    const street = this.pick(STREETS);
    const city = this.pick(CITIES);
    return `${num} ${street}, ${city}`;
  }

  city(): string {
    return this.pick(CITIES);
  }

  country(): string {
    return this.pick(COUNTRIES);
  }

  zipCode(): string {
    return String(this.randInt(10000, 100000));
  }

  company(): string {
    const last = this.pick(LAST_NAMES);
    const suffixes = ["Inc", "LLC", "Corp", "Ltd", "Group", "Solutions", "Tech"];
    return `${last} ${this.pick(suffixes)}`;
  }

  jobTitle(): string {
    return this.pick(JOB_TITLES);
  }

  paragraph(sentences = 4): string {
    const parts: string[] = [];
    for (let i = 0; i < sentences; i++) {
      parts.push(this.sentence(this.randInt(5, 13)));
    }
    return parts.join(" ");
  }

  sentence(words = 8): string {
    const parts: string[] = [];
    for (let i = 0; i < words; i++) {
      parts.push(this.pick(WORDS));
    }
    const s = parts.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }

  word(): string {
    return this.pick(WORDS);
  }

  integer(min = 0, max = 10000): number {
    return this.randInt(min, max + 1);
  }

  float(min = 0, max = 1000, decimals = 2): number {
    const raw = min + this.rng() * (max - min);
    return Number(raw.toFixed(decimals));
  }

  boolean(): boolean {
    return this.randInt(0, 2) === 1;
  }

  date(start?: string, end?: string): string {
    const startDate = start ? new Date(start) : new Date("2020-01-01");
    const endDate = end ? new Date(end) : new Date("2025-12-31");
    const diffDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000);
    const offset = this.randInt(0, diffDays + 1);
    const d = new Date(startDate.getTime() + offset * 86400000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  uuid(): string {
    if (this.seeded) {
      // Generate a UUID-like string from seeded PRNG
      const hex = () => this.randInt(0, 16).toString(16);
      const block = (n: number) => Array.from({ length: n }, hex).join("");
      return `${block(8)}-${block(4)}-${block(4)}-${block(4)}-${block(12)}`;
    }
    return randomUUID();
  }

  url(): string {
    const domain = this.pick(DOMAINS);
    const p1 = this.pick(WORDS);
    const p2 = this.pick(WORDS);
    return `https://${domain}/${p1}/${p2}`;
  }

  ipAddress(): string {
    return `${this.randInt(1, 256)}.${this.randInt(0, 256)}.${this.randInt(0, 256)}.${this.randInt(1, 256)}`;
  }

  color(): string {
    return this.pick(COLORS);
  }

  hexColor(): string {
    const hex = this.randInt(0, 0x1000000).toString(16).padStart(6, "0");
    return `#${hex}`;
  }

  /** Returns fake test credit card numbers (Luhn-valid test patterns). */
  creditCard(): string {
    const prefixes = ["4111111111111111", "5500000000000004", "340000000000009", "30000000000004"];
    return this.pick(prefixes);
  }

  currency(): string {
    return this.pick(CURRENCIES);
  }

  /**
   * Run seed files from a directory. Each file should export a default async function.
   * Returns an array of executed file paths.
   */
  async runSeeds(seedDir?: string): Promise<string[]> {
    const dir = resolve(seedDir ?? "src/seeds");
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
      .sort();
    const executed: string[] = [];
    for (const file of files) {
      const fullPath = join(dir, file);
      try {
        const mod = await import(fullPath);
        if (typeof mod.default === "function") {
          await mod.default();
        }
        executed.push(fullPath);
      } catch {
        // skip failed seed files
      }
    }
    return executed;
  }

  /**
   * Run a generator function `count` times and return the results.
   */
  run(fn: () => Record<string, unknown>, count = 1): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      results.push(fn());
    }
    return results;
  }
}

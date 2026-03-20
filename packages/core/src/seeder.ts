// Tina4 Seeder — Fake data generation and database seeding, zero dependencies.
// Uses Node.js built-in crypto for randomness. All methods are static.

import { randomInt, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// ── Helpers ──────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(arr.length)];
}

// ── Seeder Class ─────────────────────────────────────────────────

export class Seeder {
  static firstName(): string {
    return pick(FIRST_NAMES);
  }

  static lastName(): string {
    return pick(LAST_NAMES);
  }

  static fullName(): string {
    return `${Seeder.firstName()} ${Seeder.lastName()}`;
  }

  static email(): string {
    const first = Seeder.firstName().toLowerCase();
    const last = Seeder.lastName().toLowerCase();
    const domain = pick(DOMAINS);
    return `${first}.${last}@${domain}`;
  }

  static phone(): string {
    const area = randomInt(200, 1000);
    const mid = randomInt(100, 1000);
    const end = randomInt(1000, 10000);
    return `+1 (${area}) ${mid}-${end}`;
  }

  static address(): string {
    const num = randomInt(1, 1000);
    const street = pick(STREETS);
    const city = pick(CITIES);
    return `${num} ${street}, ${city}`;
  }

  static city(): string {
    return pick(CITIES);
  }

  static country(): string {
    return pick(COUNTRIES);
  }

  static zipCode(): string {
    return String(randomInt(10000, 100000));
  }

  static company(): string {
    const last = pick(LAST_NAMES);
    const suffixes = ["Inc", "LLC", "Corp", "Ltd", "Group", "Solutions", "Tech"];
    return `${last} ${pick(suffixes)}`;
  }

  static jobTitle(): string {
    return pick(JOB_TITLES);
  }

  static paragraph(sentences = 4): string {
    const parts: string[] = [];
    for (let i = 0; i < sentences; i++) {
      parts.push(Seeder.sentence(randomInt(5, 13)));
    }
    return parts.join(" ");
  }

  static sentence(words = 8): string {
    const parts: string[] = [];
    for (let i = 0; i < words; i++) {
      parts.push(pick(WORDS));
    }
    const s = parts.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }

  static word(): string {
    return pick(WORDS);
  }

  static integer(min = 0, max = 10000): number {
    return randomInt(min, max + 1);
  }

  static float(min = 0, max = 1000, decimals = 2): number {
    const raw = min + Math.random() * (max - min);
    return Number(raw.toFixed(decimals));
  }

  static boolean(): boolean {
    return randomInt(2) === 1;
  }

  static date(start?: string, end?: string): string {
    const startDate = start ? new Date(start) : new Date("2020-01-01");
    const endDate = end ? new Date(end) : new Date("2025-12-31");
    const diffDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000);
    const offset = randomInt(0, diffDays + 1);
    const d = new Date(startDate.getTime() + offset * 86400000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  static uuid(): string {
    return randomUUID();
  }

  static url(): string {
    const domain = pick(DOMAINS);
    const p1 = pick(WORDS);
    const p2 = pick(WORDS);
    return `https://${domain}/${p1}/${p2}`;
  }

  static ipAddress(): string {
    return `${randomInt(1, 256)}.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 256)}`;
  }

  static color(): string {
    return pick(COLORS);
  }

  static hexColor(): string {
    const hex = randomInt(0, 0x1000000).toString(16).padStart(6, "0");
    return `#${hex}`;
  }

  /** Returns fake test credit card numbers (Luhn-valid test patterns). */
  static creditCard(): string {
    const prefixes = ["4111111111111111", "5500000000000004", "340000000000009", "30000000000004"];
    return pick(prefixes);
  }

  static currency(): string {
    return pick(CURRENCIES);
  }

  /**
   * Run seed files from a directory. Each file should export a default async function.
   * Returns an array of executed file paths.
   */
  static async seed(seedDir?: string): Promise<string[]> {
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
  static run(fn: () => Record<string, unknown>, count = 1): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      results.push(fn());
    }
    return results;
  }
}

/**
 * Tina4 Session — Zero-dependency session management with file backend.
 *
 * Uses only Node.js built-in modules (crypto, fs, path). No external dependencies.
 *
 *   import { Session } from "./session.js";
 *
 *   const session = new Session();
 *   const id = session.start();
 *   session.set("user", { name: "Alice" });
 *   session.get("user");  // { name: "Alice" }
 *   session.destroy();
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface SessionConfig {
  /** Session backend type (currently only "file") */
  backend?: string;
  /** File storage path (default: "data/sessions") */
  path?: string;
  /** Time-to-live in seconds (default: 3600) */
  ttl?: number;
}

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

// ── Flash data prefix ─────────────────────────────────────────────

const FLASH_PREFIX = "_flash_";

// ── Session Class ─────────────────────────────────────────────────

export class Session {
  private backend: string;
  private storagePath: string;
  private ttl: number;
  private sessionId: string | null = null;
  private data: SessionData | null = null;

  constructor(backend?: string, config?: SessionConfig) {
    this.backend = backend
      ?? config?.backend
      ?? process.env.TINA4_SESSION_BACKEND
      ?? "file";
    this.storagePath = config?.path
      ?? process.env.TINA4_SESSION_PATH
      ?? "data/sessions";
    this.ttl = config?.ttl
      ?? (process.env.TINA4_SESSION_TTL ? parseInt(process.env.TINA4_SESSION_TTL, 10) : 3600);
  }

  /**
   * Start or resume a session.
   * @param sessionId - Existing session ID to resume (optional)
   * @returns The session ID
   */
  start(sessionId?: string): string {
    if (sessionId) {
      const loaded = this.load(sessionId);
      if (loaded) {
        this.sessionId = sessionId;
        this.data = loaded;
        this.data._accessed = Math.floor(Date.now() / 1000);
        this.save();
        return sessionId;
      }
    }

    // Generate new session
    this.sessionId = randomBytes(16).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    this.data = { _created: now, _accessed: now };
    this.save();
    return this.sessionId;
  }

  /**
   * Get a value from the session.
   */
  get(key: string, defaultValue?: unknown): unknown {
    if (!this.data) return defaultValue;
    if (key in this.data) {
      return this.data[key] ?? defaultValue;
    }
    return defaultValue;
  }

  /**
   * Set a value in the session.
   */
  set(key: string, value: unknown): void {
    if (!this.data) return;
    this.data[key] = value;
    this.save();
  }

  /**
   * Delete a key from the session.
   */
  delete(key: string): void {
    if (!this.data) return;
    delete this.data[key];
    this.save();
  }

  /**
   * Destroy the entire session (remove file and clear data).
   */
  destroy(): void {
    if (this.sessionId) {
      const filePath = this.filePath(this.sessionId);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch { /* ignore */ }
    }
    this.sessionId = null;
    this.data = null;
  }

  /**
   * Get all session data (excluding internal keys).
   */
  all(): Record<string, unknown> {
    if (!this.data) return {};
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.data)) {
      if (!k.startsWith("_")) {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * Check if a key exists in the session.
   */
  has(key: string): boolean {
    if (!this.data) return false;
    return key in this.data;
  }

  /**
   * Regenerate the session ID (keeps data, new ID).
   */
  regenerate(): string {
    const oldId = this.sessionId;
    const oldData = this.data;

    // Remove old file
    if (oldId) {
      const filePath = this.filePath(oldId);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch { /* ignore */ }
    }

    // New ID, keep data
    this.sessionId = randomBytes(16).toString("hex");
    this.data = oldData ?? { _created: Math.floor(Date.now() / 1000), _accessed: Math.floor(Date.now() / 1000) };
    this.data._accessed = Math.floor(Date.now() / 1000);
    this.save();
    return this.sessionId;
  }

  /**
   * Set flash data (auto-deleted after first read).
   */
  flash(key: string, value: unknown): void {
    this.set(`${FLASH_PREFIX}${key}`, value);
  }

  /**
   * Get flash data (auto-deleted after read).
   */
  getFlash(key: string, defaultValue?: unknown): unknown {
    const flashKey = `${FLASH_PREFIX}${key}`;
    if (!this.data || !(flashKey in this.data)) return defaultValue;
    const value = this.data[flashKey];
    delete this.data[flashKey];
    this.save();
    return value ?? defaultValue;
  }

  /**
   * Get the current session ID.
   */
  getId(): string | null {
    return this.sessionId;
  }

  // ── Private: File backend ──────────────────────────────────────

  private ensureDir(): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
  }

  private filePath(id: string): string {
    return join(this.storagePath, `${id}.json`);
  }

  private save(): void {
    if (!this.sessionId || !this.data) return;
    this.ensureDir();
    writeFileSync(this.filePath(this.sessionId), JSON.stringify(this.data), "utf-8");
  }

  private load(id: string): SessionData | null {
    const filePath = this.filePath(id);
    try {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as SessionData;

      // Check TTL
      const now = Math.floor(Date.now() / 1000);
      if (data._accessed && (now - data._accessed) > this.ttl) {
        // Session expired — remove file
        try { unlinkSync(filePath); } catch { /* ignore */ }
        return null;
      }

      return data;
    } catch {
      return null;
    }
  }
}

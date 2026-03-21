/**
 * Lightweight dependency injection container.
 *
 * Matches the Python tina4_python.container.Container API.
 *
 *   import { Container, container } from "@tina4/core";
 *
 *   container.register("mailer", () => new MailService());
 *   container.singleton("db", () => new Database("sqlite:///app.db"));
 *
 *   const mailer = container.get<MailService>("mailer"); // new instance each call
 *   const db     = container.get<Database>("db");        // same instance every call
 *
 * Node.js is single-threaded so no locking is needed.
 */

export class Container {
  private transients = new Map<string, () => unknown>();
  private singletons = new Map<string, () => unknown>();
  private instances = new Map<string, unknown>();

  /**
   * Register a transient factory — a new instance is created on every `get()` call.
   */
  register(name: string, factory: () => unknown): void {
    if (typeof factory !== "function") {
      throw new TypeError(`factory for '${name}' must be callable`);
    }
    // Remove from singletons/instances if previously registered there
    this.singletons.delete(name);
    this.instances.delete(name);
    this.transients.set(name, factory);
  }

  /**
   * Register a singleton factory — created once on first `get()`, then memoised.
   */
  singleton(name: string, factory: () => unknown): void {
    if (typeof factory !== "function") {
      throw new TypeError(`factory for '${name}' must be callable`);
    }
    // Remove from transients if previously registered there
    this.transients.delete(name);
    this.instances.delete(name);
    this.singletons.set(name, factory);
  }

  /**
   * Resolve a dependency by name.
   *
   * Throws an `Error` if the name has not been registered.
   */
  get<T = unknown>(name: string): T {
    // Check transient first
    const transientFactory = this.transients.get(name);
    if (transientFactory) {
      return transientFactory() as T;
    }

    // Check singleton
    const singletonFactory = this.singletons.get(name);
    if (singletonFactory) {
      if (!this.instances.has(name)) {
        this.instances.set(name, singletonFactory());
      }
      return this.instances.get(name) as T;
    }

    throw new Error(`service not registered: ${name}`);
  }

  /**
   * Return `true` if *name* has been registered (transient or singleton).
   */
  has(name: string): boolean {
    return this.transients.has(name) || this.singletons.has(name);
  }

  /**
   * Clear all registrations and cached instances.
   */
  reset(): void {
    this.transients.clear();
    this.singletons.clear();
    this.instances.clear();
  }
}

/** Default container instance. */
export const container = new Container();

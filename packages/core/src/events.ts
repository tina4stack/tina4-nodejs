/**
 * Tina4 Events — Simple observer pattern for decoupled communication.
 *
 * Zero-dependency event system. Fire events, register listeners.
 *
 *   Events.on("user.created", (user) => console.log(`Welcome ${user.name}!`));
 *   Events.emit("user.created", { name: "Alice", email: "alice@example.com" });
 *
 * One-time listeners:
 *
 *   Events.once("app.ready", () => console.log("App started!"));
 */

import { Log } from "./logger.js";

interface ListenerEntry {
    priority: number;
    callback: (...args: unknown[]) => void;
    once: boolean;
}

const _listeners: Map<string, ListenerEntry[]> = new Map();

/**
 * Log a listener error — NEVER silent. Mirrors Python's _log_listener_error:
 * routes through the Tina4 Log (warning) with BOTH the event name and the
 * error type + message. The log call is itself wrapped so a broken logger
 * can't break the event bus — on any logger failure it falls back to
 * console.error so the error is still surfaced.
 */
function logListenerError(event: string, error: unknown): void {
    const err = error as { name?: string; message?: string };
    const type = err?.name ?? (error as object)?.constructor?.name ?? "Error";
    const message = err?.message ?? String(error);
    try {
        Log.warning(`Event listener for '${event}' raised ${type}: ${message}`);
    } catch {
        try {
            console.error(`Event listener for '${event}' raised ${type}: ${message}`);
        } catch {
            /* a broken console can't break the bus either */
        }
    }
}

/**
 * Mirror Python's keyword-only `strict` param within JS's positional-args
 * model. If the FIRST emit argument is a plain options object carrying a
 * boolean `strict`, it is consumed as the option and the remaining args are
 * the event payload; otherwise every arg is treated as payload (so the
 * common `emit("evt", a, b)` call is unchanged). Listeners never see the
 * options object.
 */
function parseEmitArgs(rest: unknown[]): { strict: boolean; args: unknown[] } {
    const first = rest[0];
    if (
        first !== null &&
        typeof first === "object" &&
        !Array.isArray(first) &&
        Object.prototype.hasOwnProperty.call(first, "strict") &&
        typeof (first as { strict?: unknown }).strict === "boolean"
    ) {
        return { strict: (first as { strict: boolean }).strict, args: rest.slice(1) };
    }
    return { strict: false, args: rest };
}

function getEntries(event: string): ListenerEntry[] {
    let entries = _listeners.get(event);
    if (!entries) {
        entries = [];
        _listeners.set(event, entries);
    }
    return entries;
}

export class Events {
    /**
     * Register a listener for an event.
     * Higher priority runs first.
     */
    static on(event: string, callback: (...args: unknown[]) => void, priority: number = 0): void {
        const entries = getEntries(event);
        entries.push({ priority, callback, once: false });
        entries.sort((a, b) => b.priority - a.priority);
    }

    /**
     * Register a listener that fires only once then auto-removes.
     */
    static once(event: string, callback: (...args: unknown[]) => void, priority: number = 0): void {
        const entries = getEntries(event);
        entries.push({ priority, callback, once: true });
        entries.sort((a, b) => b.priority - a.priority);
    }

    /**
     * Remove a specific listener, or all listeners for an event.
     *
     *   Events.off("user.created", handler)  // remove specific
     *   Events.off("user.created")           // remove all for event
     */
    static off(event: string, callback?: (...args: unknown[]) => void): void {
        if (callback === undefined) {
            _listeners.delete(event);
        } else {
            const entries = _listeners.get(event);
            if (entries) {
                const filtered = entries.filter((e) => e.callback !== callback);
                _listeners.set(event, filtered);
            }
        }
    }

    /**
     * Fire an event synchronously. Returns array of listener results.
     *
     * Listener isolation (E1): each listener call is wrapped — a listener
     * that THROWS does NOT abort the rest of emit(). The error is LOGGED
     * (never silent) and the failed listener contributes a `null` slot, so
     * N listeners always yield N results in priority order; surviving
     * listeners run regardless of an earlier throw.
     *
     * Pass `{ strict: true }` to RE-RAISE on the first listener error
     * instead of isolating it (later listeners then do NOT run).
     *
     * once() cleanup stays correct under isolation: the one-shot listener is
     * spliced out BEFORE its callback runs, so a throw never leaves it
     * registered.
     */
    static emit(event: string, ...args: unknown[]): unknown[];
    static emit(event: string, options: { strict?: boolean }, ...args: unknown[]): unknown[];
    static emit(event: string, ...rest: unknown[]): unknown[] {
        const { strict, args } = parseEmitArgs(rest);
        const entries = _listeners.get(event);
        if (!entries) return [];

        const snapshot = [...entries];
        const results: unknown[] = [];

        for (const entry of snapshot) {
            if (entry.once) {
                const idx = entries.indexOf(entry);
                if (idx !== -1) entries.splice(idx, 1);
            }
            try {
                results.push(entry.callback(...args));
            } catch (error) {
                if (strict) throw error;
                logListenerError(event, error);
                results.push(null);
            }
        }

        return results;
    }

    /**
     * Emit an event and await all async listeners.
     * Returns array of resolved results from each listener.
     *
     * Listener isolation (E1): identical to emit() — each awaited listener
     * is isolated; a rejection/throw is LOGGED and contributes a `null`
     * slot without aborting the others. `{ strict: true }` re-raises on the
     * first error.
     */
    static async emitAsync(event: string, ...args: unknown[]): Promise<unknown[]>;
    static async emitAsync(event: string, options: { strict?: boolean }, ...args: unknown[]): Promise<unknown[]>;
    static async emitAsync(event: string, ...rest: unknown[]): Promise<unknown[]> {
        const { strict, args } = parseEmitArgs(rest);
        const entries = _listeners.get(event);
        if (!entries) return [];

        const snapshot = [...entries];
        const results: unknown[] = [];

        for (const entry of snapshot) {
            if (entry.once) {
                const idx = entries.indexOf(entry);
                if (idx !== -1) entries.splice(idx, 1);
            }
            try {
                results.push(await entry.callback(...args));
            } catch (error) {
                if (strict) throw error;
                logListenerError(event, error);
                results.push(null);
            }
        }

        return results;
    }

    /**
     * Get all listener callbacks for an event (in priority order).
     */
    static listeners(event: string): Array<(...args: unknown[]) => void> {
        const entries = _listeners.get(event);
        if (!entries) return [];
        return entries.map((e) => e.callback);
    }

    /**
     * List all registered event names.
     */
    static events(): string[] {
        return [..._listeners.keys()];
    }

    /**
     * Remove all listeners for all events.
     */
    static clear(): void {
        _listeners.clear();
    }
}

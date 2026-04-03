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

interface ListenerEntry {
    priority: number;
    callback: (...args: unknown[]) => void;
    once: boolean;
}

const _listeners: Map<string, ListenerEntry[]> = new Map();

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
     */
    static emit(event: string, ...args: unknown[]): unknown[] {
        const entries = _listeners.get(event);
        if (!entries) return [];

        const snapshot = [...entries];
        const results: unknown[] = [];

        for (const entry of snapshot) {
            if (entry.once) {
                const idx = entries.indexOf(entry);
                if (idx !== -1) entries.splice(idx, 1);
            }
            results.push(entry.callback(...args));
        }

        return results;
    }

    /**
     * Emit an event and await all async listeners.
     * Returns array of resolved results from each listener.
     */
    static async emitAsync(event: string, ...args: unknown[]): Promise<unknown[]> {
        const entries = _listeners.get(event);
        if (!entries) return [];

        const snapshot = [...entries];
        const results: unknown[] = [];

        for (const entry of snapshot) {
            if (entry.once) {
                const idx = entries.indexOf(entry);
                if (idx !== -1) entries.splice(idx, 1);
            }
            results.push(await entry.callback(...args));
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

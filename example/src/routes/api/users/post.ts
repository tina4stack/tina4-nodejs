import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_CREATED, HTTP_BAD_REQUEST } from "@tina4/core";
import { getDatabase } from "@tina4/orm";

export const meta = { summary: "Create a user", tags: ["Users"] };

export default async function (request: Tina4Request, response: Tina4Response) {
    const { name, email, role } = request.body as { name?: string; email?: string; role?: string };

    if (!name || !email) {
        return response.json({ error: "name and email are required" }, HTTP_BAD_REQUEST);
    }

    const db = getDatabase();
    db.execute(
        "INSERT INTO users (name, email, role, active, created_at) VALUES (?, ?, ?, 1, datetime('now'))",
        [name, email, role ?? "user"],
    );

    return response.json({ name, email, role: role ?? "user", active: true }, HTTP_CREATED);
}

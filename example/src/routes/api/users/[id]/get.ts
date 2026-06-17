import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK, HTTP_NOT_FOUND } from "@tina4/core";
import { Database, getAdapter } from "@tina4/orm";

export const meta = { summary: "Get user by ID", tags: ["Users"] };

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = new Database(getAdapter());
    const user = await db.fetchOne("SELECT * FROM users WHERE id = ?", [request.params.id]);

    if (user) {
        return response(user, HTTP_OK);
    }

    return response.json({ error: "User not found" }, HTTP_NOT_FOUND);
}

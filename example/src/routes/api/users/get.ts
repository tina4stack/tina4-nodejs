import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK } from "@tina4/core";
import { getDatabase } from "@tina4/orm";

export const meta = { summary: "List all users", tags: ["Users"] };

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getDatabase();
    const users = db.fetch("SELECT * FROM users ORDER BY id");
    return response(users, HTTP_OK);
}

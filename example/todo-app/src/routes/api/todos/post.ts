import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_CREATED } from "@tina4/core";
import { getDatabase } from "@tina4/orm";

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getDatabase();
    const { title } = request.body;
    db.execute("INSERT INTO todo (title, completed, created_at) VALUES (?, 0, datetime('now'))", [title]);
    return response({ title, completed: 0 }, HTTP_CREATED);
}

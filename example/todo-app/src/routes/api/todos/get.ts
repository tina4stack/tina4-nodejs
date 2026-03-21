import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK } from "@tina4/core";
import { getDatabase } from "@tina4/orm";

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getDatabase();
    const todos = db.fetch("SELECT * FROM todo ORDER BY created_at DESC");
    return response(todos, HTTP_OK);
}

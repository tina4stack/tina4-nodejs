import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK, HTTP_NOT_FOUND } from "@tina4/core";
import { getDatabase } from "@tina4/orm";

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getDatabase();
    const result = db.execute("DELETE FROM todo WHERE id = ?", [request.params.id]);
    if (result.changes > 0) {
        return response({ message: "Deleted" }, HTTP_OK);
    }
    return response({ error: "Not found" }, HTTP_NOT_FOUND);
}

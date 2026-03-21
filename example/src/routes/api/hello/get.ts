import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK } from "@tina4/core";

export const meta = { summary: "Hello world", tags: ["Hello"] };

export default async function (request: Tina4Request, response: Tina4Response) {
    return response.json({ message: "Hello from Tina4!", timestamp: new Date().toISOString() }, HTTP_OK);
}

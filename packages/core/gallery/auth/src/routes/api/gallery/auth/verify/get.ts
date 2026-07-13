/** Gallery: Auth — verify a JWT token. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token") ?? "";

  // In a real app: import { Auth } from "tina4-nodejs";
  // const auth = new Auth();
  // const isValid = auth.validateToken(token);
  // For the gallery demo, just check the token has 3 parts
  const parts = token.split(".");
  const valid = parts.length === 3 && parts.every((p) => p.length > 0);

  return res.json({ valid });
}

/** Gallery: Auth — login endpoint, returns a JWT token. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response) {
  const body = (req.body as Record<string, unknown>) ?? {};
  const username = (body.username as string) ?? "";
  const password = (body.password as string) ?? "";

  if (username && password) {
    // In a real app: import { Auth } from "tina4-nodejs";
    // const auth = new Auth();
    // const token = auth.createToken({ username, role: "user" });
    // For the gallery demo, generate a simple base64 token
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ username, role: "user", iat: Math.floor(Date.now() / 1000) })).toString("base64url");
    const signature = Buffer.from("gallery-demo-signature").toString("base64url");
    const token = `${header}.${payload}.${signature}`;
    return res.json({ token, message: `Welcome ${username}!` });
  }

  return res.json({ error: "Username and password required" }, 401);
}

/** Gallery: Error Overlay — deliberately crash to demo the debug overlay.
 *
 * In debug mode (TINA4_DEBUG=true), you will see:
 * - Exception type and message
 * - Stack trace with syntax-highlighted source code
 * - The exact line that caused the error (highlighted)
 * - Request details (method, path, headers)
 * - Environment info (framework version, Node.js version)
 */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (_req: Tina4Request, _res: Tina4Response) {
  // Simulate a realistic error — accessing a missing property
  const user: Record<string, string> = { name: "Alice", email: "alice@example.com" };
  const role = (user as any).role.toUpperCase(); // TypeError — this line will be highlighted in the overlay
  return _res.json({ role });
}

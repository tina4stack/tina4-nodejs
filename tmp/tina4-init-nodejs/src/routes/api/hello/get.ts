import type { Tina4Request, Tina4Response } from "@tina4/core";

export const meta = {
  summary: "Hello World",
  tags: ["Example"],
};

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  res.json({ message: "Hello from Tina4!", timestamp: new Date().toISOString() });
}

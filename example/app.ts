import { createServer } from "@tina4/core";
import { initDatabase } from "@tina4/orm";

const db = initDatabase("sqlite:example.db");

const port = parseInt(process.env.PORT || "7148", 10);
const host = process.env.HOST || "0.0.0.0";
createServer({ port, host });

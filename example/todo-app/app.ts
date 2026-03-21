import { createServer } from "@tina4/core";
import { initDatabase } from "@tina4/orm";

const db = initDatabase("sqlite:todos.db");

createServer({ port: 7148 });

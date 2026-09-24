/**
 * Tina4 SQL Translation — Cross-engine SQL translator.
 *
 * Translates SQL dialect differences between engines so that application
 * code can use a single SQL style and have it adapted at runtime.
 *
 *   import { SQLTranslator } from "@tina4/orm";
 *
 *   // Firebird: LIMIT/OFFSET → ROWS X TO Y
 *   SQLTranslator.limitToRows("SELECT * FROM users LIMIT 10 OFFSET 5");
 *   // → "SELECT * FROM users ROWS 6 TO 15"
 *
 *   // MSSQL: LIMIT → TOP N
 *   SQLTranslator.limitToTop("SELECT * FROM users LIMIT 10");
 *   // → "SELECT TOP 10 * FROM users"
 *
 * Also includes a query cache with TTL support.
 */

// ── SQL Translator ───────────────────────────────────────────

import { DatabaseUrl } from "./databaseUrl.js";
import { DEFAULT_SRID, SpatialNotSupportedError } from "./point.js";
export class SQLTranslator {
  private static readonly SPATIAL_ENGINES = new Set(["postgres", "postgresql"]);
  private static readonly SPATIAL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

  static requireSpatial(engine: string, feature: string): string {
    const name = String(engine || "unknown").toLowerCase();
    if (!SQLTranslator.SPATIAL_ENGINES.has(name)) {
      throw new SpatialNotSupportedError(
        `${feature} is not supported on the '${name}' database engine. ` +
        "Tina4 GIS support is PostGIS-first: use PostgreSQL with CREATE EXTENSION postgis. " +
        "Tina4 will not replace a spatial query with an approximate coordinate query.",
      );
    }
    return name;
  }

  static spatialIdentifier(name: string, what = "column"): string {
    if (!SQLTranslator.SPATIAL_IDENTIFIER.test(name)) throw new TypeError(`Spatial ${what} is not a valid SQL identifier: ${name}`);
    return name;
  }

  static pointColumnType(engine: string, srid = DEFAULT_SRID): string {
    SQLTranslator.requireSpatial(engine, "PointField");
    return `geography(Point,${srid})`;
  }

  static spatialIndex(engine: string, table: string, column: string): string {
    SQLTranslator.requireSpatial(engine, "spatial index creation");
    table = SQLTranslator.spatialIdentifier(table, "table");
    column = SQLTranslator.spatialIdentifier(column);
    return `CREATE INDEX IF NOT EXISTS ${table.replaceAll(".", "_")}_${column}_gist ON ${table} USING GIST (${column})`;
  }

  static pointLiteral(engine: string, srid = DEFAULT_SRID): string {
    SQLTranslator.requireSpatial(engine, "spatial predicates");
    return `ST_SetSRID(ST_MakePoint(?, ?), ${srid})::geography`;
  }

  static withinDistance(engine: string, column: string, srid = DEFAULT_SRID): string {
    return `ST_DWithin(${SQLTranslator.spatialIdentifier(column)}, ${SQLTranslator.pointLiteral(engine, srid)}, ?)`;
  }

  static distance(engine: string, column: string, srid = DEFAULT_SRID): string {
    return `ST_Distance(${SQLTranslator.spatialIdentifier(column)}, ${SQLTranslator.pointLiteral(engine, srid)})`;
  }

  static distanceAs(engine: string, column: string, alias: string, srid = DEFAULT_SRID): string {
    return `${SQLTranslator.distance(engine, column, srid)} AS ${SQLTranslator.spatialIdentifier(alias, "result alias")}`;
  }

  static geometryLiteral(engine: string, form: "ewkt" | "geojson", srid = DEFAULT_SRID): string {
    SQLTranslator.requireSpatial(engine, "spatial predicates");
    return form === "ewkt" ? "ST_GeogFromText(?)" : `ST_SetSRID(ST_GeomFromGeoJSON(?), ${srid})::geography`;
  }

  static intersects(engine: string, column: string, form: "ewkt" | "geojson" = "ewkt", srid = DEFAULT_SRID): string {
    return `ST_Intersects(${SQLTranslator.spatialIdentifier(column)}, ${SQLTranslator.geometryLiteral(engine, form, srid)})`;
  }

  static bbox(engine: string, column: string, srid = DEFAULT_SRID): string {
    SQLTranslator.requireSpatial(engine, "bbox");
    return `ST_Intersects(${SQLTranslator.spatialIdentifier(column)}, ST_MakeEnvelope(?, ?, ?, ?, ${srid})::geography)`;
  }
  /**
   * Convert LIMIT/OFFSET to Firebird ROWS...TO syntax.
   *
   * LIMIT 10 OFFSET 5  →  ROWS 6 TO 15
   * LIMIT 10           →  ROWS 1 TO 10
   */
  static limitToRows(sql: string): string {
    // Match LIMIT n OFFSET m at end of statement
    const limitOffset = /\bLIMIT\s+(\d+)\s+OFFSET\s+(\d+)\s*$/i;
    let m = sql.match(limitOffset);
    if (m) {
      const limit = parseInt(m[1], 10);
      const offset = parseInt(m[2], 10);
      const start = offset + 1;
      const end = offset + limit;
      return sql.slice(0, m.index) + `ROWS ${start} TO ${end}`;
    }

    // Match LIMIT n at end of statement
    const limitOnly = /\bLIMIT\s+(\d+)\s*$/i;
    m = sql.match(limitOnly);
    if (m) {
      const limit = parseInt(m[1], 10);
      return sql.slice(0, m.index) + `ROWS 1 TO ${limit}`;
    }

    return sql;
  }

  /**
   * Convert LIMIT to MSSQL TOP syntax.
   *
   * SELECT ... LIMIT 10  →  SELECT TOP 10 ...
   * Does NOT convert if OFFSET is present (TOP doesn't support it).
   */
  static limitToTop(sql: string): string {
    const limitOnly = /\bLIMIT\s+(\d+)\s*$/i;
    const m = sql.match(limitOnly);
    if (m && !/\bOFFSET\b/i.test(sql)) {
      const limit = parseInt(m[1], 10);
      const body = sql.slice(0, m.index).trim();
      return body.replace(/^(SELECT)\b/i, `$1 TOP ${limit}`);
    }
    return sql;
  }

  // ── Literal-safe rewriting ──────────────────────────────────────
  //
  // A dialect rewrite (|| -> CONCAT, TRUE -> 1, ILIKE -> LOWER LIKE) must NEVER
  // touch text inside a string literal, a quoted identifier or a comment: a
  // column value of 'a||b', a label 'TRUE', or a LIKE pattern that mentions
  // ILIKE is DATA, not SQL. Each transform masks every literal/identifier/comment
  // to an opaque token, rewrites the masked SQL, then restores the tokens, so the
  // rewrite only ever sees real SQL structure.

  /** Replace string literals, quoted identifiers and comments with opaque
   * `\x00N\x00` tokens (doubled-quote escapes handled). */
  private static maskLiterals(sql: string): { masked: string; literals: string[] } {
    const literals: string[] = [];
    let out = "";
    let i = 0;
    const n = sql.length;
    while (i < n) {
      const c = sql[i];
      const next = sql[i + 1];
      if (c === "'" || c === '"' || c === "`") {
        const start = i;
        i++;
        while (i < n) {
          if (sql[i] === c) {
            if (sql[i + 1] === c) { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        out += `\x00${literals.length}\x00`;
        literals.push(sql.slice(start, i));
        continue;
      }
      if (c === "-" && next === "-") {
        const start = i;
        while (i < n && sql[i] !== "\n") i++;
        out += `\x00${literals.length}\x00`;
        literals.push(sql.slice(start, i));
        continue;
      }
      if (c === "/" && next === "*") {
        const start = i;
        i += 2;
        while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
        i = Math.min(i + 2, n);
        out += `\x00${literals.length}\x00`;
        literals.push(sql.slice(start, i));
        continue;
      }
      out += c;
      i++;
    }
    return { masked: out, literals };
  }

  /** Inverse of maskLiterals. */
  private static restoreLiterals(masked: string, literals: string[]): string {
    return masked.replace(/\x00(\d+)\x00/g, (_m, idx) => literals[Number(idx)]);
  }

  // A concat/ilike operand: a masked literal-or-identifier token, a simple
  // function call, a (qualified) identifier, a placeholder, or a number. The
  // function-call args exclude `|` so a nested `||` never splits the chain.
  private static readonly PRIMARY =
    "(?:\\x00\\d+\\x00|[A-Za-z_][\\w$]*\\s*\\([^()|]*\\)|[A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)*|:[A-Za-z_]\\w*|\\$\\d+|\\?|%s|\\d+(?:\\.\\d+)?)";

  /**
   * Convert `||` string concatenation to `CONCAT(...)` for MySQL/MSSQL.
   *
   * Rewrites ONLY `||` operators joining expression operands OUTSIDE any string
   * literal or comment, and only the operand chain — never the whole statement:
   *   SELECT a || b FROM t   ->  SELECT CONCAT(a, b) FROM t
   *   WHERE data = 'a||b'    ->  WHERE data = 'a||b'   (literal untouched)
   */
  static concatPipesToFunc(sql: string): string {
    if (!sql.includes("||")) return sql;
    const { masked, literals } = SQLTranslator.maskLiterals(sql);
    if (!masked.includes("||")) return sql; // every || was inside a literal/comment
    const chain = new RegExp(
      `${SQLTranslator.PRIMARY}(?:\\s*\\|\\|\\s*${SQLTranslator.PRIMARY})+`,
      "g",
    );
    const rewritten = masked.replace(chain, (m) => "CONCAT(" + m.split(/\s*\|\|\s*/).join(", ") + ")");
    return SQLTranslator.restoreLiterals(rewritten, literals);
  }

  /**
   * Convert bare TRUE/FALSE to 1/0 for engines without a boolean type. A
   * TRUE/FALSE INSIDE a string literal is data and is left untouched
   * (`WHERE label = 'TRUE'` is preserved).
   */
  static booleanToInt(sql: string): string {
    if (!/\b(?:TRUE|FALSE)\b/i.test(sql)) return sql;
    const { masked, literals } = SQLTranslator.maskLiterals(sql);
    const rewritten = masked.replace(/\bTRUE\b/gi, "1").replace(/\bFALSE\b/gi, "0");
    return SQLTranslator.restoreLiterals(rewritten, literals);
  }

  /**
   * Convert `col ILIKE pattern` to `LOWER(col) LIKE LOWER(pattern)` for engines
   * without ILIKE. The pattern operand is captured whole (a multi-word
   * `'%two words%'` survives) and an ILIKE INSIDE a string literal is untouched.
   */
  static ilikeToLike(sql: string): string {
    if (!/ilike/i.test(sql)) return sql;
    const { masked, literals } = SQLTranslator.maskLiterals(sql);
    const re = new RegExp(
      `(${SQLTranslator.PRIMARY})\\s+ILIKE\\s+(${SQLTranslator.PRIMARY})`,
      "gi",
    );
    const rewritten = masked.replace(re, (_m, col: string, val: string) => `LOWER(${col}) LIKE LOWER(${val})`);
    return SQLTranslator.restoreLiterals(rewritten, literals);
  }

  /**
   * Translate AUTOINCREMENT across engines in DDL.
   */
  static autoIncrementSyntax(sql: string, engine: string): string {
    switch (engine) {
      case "mysql":
        return sql.replace(/AUTOINCREMENT/gi, "AUTO_INCREMENT");
      case "postgresql":
        // BIGINT PRIMARY KEY AUTOINCREMENT -> BIGSERIAL (a real 64-bit sequence);
        // INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL. A plain BIGINT with the
        // keyword merely stripped has no sequence and cannot auto-increment.
        return sql
          .replace(/\bBIGINT\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "BIGSERIAL PRIMARY KEY")
          .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "SERIAL PRIMARY KEY")
          .split(/\bAUTOINCREMENT\b/gi).map((part, index, parts) => index < parts.length - 1 ? part.trimEnd() : part).join("");
      case "mssql":
        return sql.replace(/AUTOINCREMENT/gi, "IDENTITY(1,1)");
      case "firebird":
        return sql.split(/\bAUTOINCREMENT\b/gi).map((part, index, parts) => index < parts.length - 1 ? part.trimEnd() : part).join("");
      default:
        return sql;
    }
  }

  /**
   * Translate SQLite-canonical DDL column TYPES + CREATE-TABLE options to the
   * target engine.
   *
   * ONLY acts on `CREATE TABLE` / `ALTER TABLE` statements, so a query or INSERT
   * that happens to contain the word `TEXT` (a column name, a string literal) is
   * never rewritten. Complements `autoIncrementSyntax` (which maps the id
   * keyword) so ONE portable migration — and every `Model.createTable()` DDL,
   * which is also SQLite-canonical — applies on every engine instead of failing
   * on Firebird/MSSQL.
   *
   *   * Firebird has no `TEXT` (-607), no `REAL`, and no `CREATE TABLE IF NOT
   *     EXISTS`.
   *   * MSSQL has no `CREATE TABLE IF NOT EXISTS` and its `TIMESTAMP` is a
   *     rowversion, not a datetime — a `created_at TIMESTAMP` there is wrong.
   *   * MySQL's `TIMESTAMP` carries auto-update / 2038 surprises, so a datetime
   *     column maps to `DATETIME` (matching the adapters' createTableAsync).
   */
  static ddlTypes(sql: string, engine: string): string {
    // Gate to DDL only, tolerating leading `-- ...` comment lines / blank lines
    // that a migration file carries before its CREATE TABLE. A SELECT or INSERT
    // that merely mentions a type keyword is never rewritten.
    const head = sql.replace(/^(?:\s*--[^\n]*\n)+/, "");
    if (!/^\s*(?:CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(head)) return sql;
    switch ((engine ?? "").toLowerCase()) {
      case "firebird":
        return sql
          .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
          // Map bare TEXT -> BLOB SUB_TYPE TEXT, but leave an existing
          // "BLOB SUB_TYPE TEXT" intact (it already contains the word TEXT).
          .replace(/\bBLOB\s+SUB_TYPE\s+TEXT\b/gi, "\x00FBTEXT\x00")
          .replace(/\bTEXT\b/gi, "BLOB SUB_TYPE TEXT")
          .replaceAll("\x00FBTEXT\x00", "BLOB SUB_TYPE TEXT")
          .replace(/\bREAL\b/gi, "DOUBLE PRECISION");
      case "mssql":
        return sql
          .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
          .replace(/\bTIMESTAMP\b/gi, "DATETIME2");
      case "mysql":
        return sql.replace(/\bTIMESTAMP\b/gi, "DATETIME");
      default:
        return sql;
    }
  }

  /**
   * Convert ? placeholders to engine-specific style.
   *
   * ? → %s (MySQL, PostgreSQL)
   * ? → :1, :2, :3 (Oracle, Firebird)
   */
  static placeholderStyle(sql: string, style: string): string {
    if (style === "%s") {
      // A pyformat driver (psycopg, PyMySQL) reads EVERY `%` as the start of a
      // placeholder once parameters are passed, literals included, so a literal
      // `%` is doubled before the real `?` markers become `%s` (tina4-python#138).
      const doubled = sql.replace(/%/g, "%%");
      return SQLTranslator.replacePlaceholders(doubled, () => "%s");
    }
    if (style.startsWith(":")) {
      return SQLTranslator.replacePlaceholders(sql, (i) => `:${i + 1}`);
    }
    return sql;
  }

  /**
   * Offsets of the REAL `?` placeholders in a statement: every `?` that is not
   * inside a string literal ('...', Postgres E'...', dollar-quoted $$...$$ /
   * $tag$...$tag$), a quoted identifier ("..." or `...`), or a comment (-- to
   * end of line, /* ... *\/). A plain text replace turned the `?` in
   * `SELECT 'why?' AS v, ? AS n` into a placeholder and shifted every binding
   * after it (tina4-python#138).
   *
   * @param sql Raw SQL, exactly as the caller wrote it.
   * @param options.backslashEscapes Treat `\` as an escape inside '...' and
   *   "..." as well (MySQL's default string syntax). E'...' always does.
   */
  static placeholderPositions(sql: string, options: { backslashEscapes?: boolean } = {}): number[] {
    const positions: number[] = [];
    const n = sql.length;
    const isIdent = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_]/.test(ch);
    let i = 0;
    while (i < n) {
      const c = sql[i];
      const next = sql[i + 1];

      if (c === "'" || c === '"' || c === "`") {
        // E'...' (Postgres escape string) honours backslash escapes; so does
        // every quoted string when the engine does (MySQL).
        const prev = sql[i - 1];
        const escapeString = c === "'" && (prev === "E" || prev === "e") && !isIdent(sql[i - 2]);
        const backslash = c !== "`" && (escapeString || options.backslashEscapes === true);
        i++;
        while (i < n) {
          if (backslash && sql[i] === "\\") { i += 2; continue; }
          if (sql[i] === c) {
            if (sql[i + 1] === c) { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        continue;
      }

      if (c === "-" && next === "-") {
        while (i < n && sql[i] !== "\n") i++;
        continue;
      }

      if (c === "/" && next === "*") {
        const end = sql.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }

      if (c === "$" && !isIdent(sql[i - 1])) {
        const tag = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
        if (tag) {
          const end = sql.indexOf(tag[0], i + tag[0].length);
          i = end === -1 ? n : end + tag[0].length;
          continue;
        }
      }

      if (c === "?") positions.push(i);
      i++;
    }
    return positions;
  }

  /**
   * Replace each REAL `?` placeholder (see placeholderPositions) with
   * `marker(index)`, index counting from 0. Literals, quoted identifiers and
   * comments are copied through untouched.
   */
  static replacePlaceholders(
    sql: string,
    marker: (index: number) => string,
    options: { backslashEscapes?: boolean } = {},
  ): string {
    const positions = SQLTranslator.placeholderPositions(sql, options);
    if (positions.length === 0) return sql;
    let out = "";
    let last = 0;
    positions.forEach((pos, index) => {
      out += sql.slice(last, pos) + marker(index);
      last = pos + 1;
    });
    return out + sql.slice(last);
  }

  /**
   * Detect and strip RETURNING clause from INSERT/UPDATE statements.
   * Returns the cleaned SQL and the list of RETURNING columns.
   *
   * "INSERT INTO t (x) VALUES (1) RETURNING id, name"
   * → { sql: "INSERT INTO t (x) VALUES (1)", columns: ["id", "name"] }
   */
  static parseReturning(sql: string): { sql: string; columns: string[] } {
    const m = sql.match(/\bRETURNING\s+(.+)$/i);
    if (!m) return { sql, columns: [] };
    const columns = m[1].split(",").map((c) => c.trim());
    return {
      sql: sql.slice(0, m.index!).trim(),
      columns,
    };
  }

  /**
   * v3.13.14 (#48): split a possibly-qualified table name into [schema, table].
   *
   * A model whose table name is qualified — PostgreSQL "gift_cards.gift_card",
   * MSSQL "dbo.widget", MySQL "otherdb.table", SQLite "attached.table" — lives
   * in that schema/catalog, not the default. Adapters use this so tableExists /
   * getColumns query the right namespace instead of matching the whole dotted
   * string as one flat name. Returns [null, name] for a bare name. Splits on the
   * first dot. Firebird has no schemas, so its adapter ignores this.
   */
  static splitSchema(name: string): [string | null, string] {
    const idx = name.indexOf(".");
    if (idx === -1) return [null, name];
    return [name.slice(0, idx), name.slice(idx + 1)];
  }

  /**
   * Hard per-statement bind-parameter ceiling per engine. 0 = never collapse.
   * Sourced from test/fixtures/batch_write_contract.json, byte-identical in all
   * four frameworks.
   */
  static readonly MAX_BIND_PARAMS: Record<string, number> = {
    sqlite: 999,
    postgres: 65535,
    mysql: 65535,
    mssql: 2100,
    firebird: 0,
    odbc: 0,
    mongodb: 0,
  };

  /**
   * The four frameworks do not agree on what an engine calls itself — Python
   * and PHP report "postgresql", Ruby and Node report "postgres". Without
   * normalising, the cap lookup misses and the collapse silently does nothing
   * on the engine with the largest win.
   */
  static readonly ENGINE_ALIASES: Record<string, string> = {
    postgresql: "postgres",
    pgsql: "postgres",
    sqlite3: "sqlite",
    sqlserver: "mssql",
    sqlsrv: "mssql",
    mariadb: "mysql",
  };

  // The `d` flag records group indices, so the head can be sliced at the exact
  // start of the VALUES group rather than by hunting for a parenthesis (the
  // column list has parentheses too).
  private static readonly INSERT_VALUES =
    /^\s*INSERT\s+INTO\s+.+?\s+VALUES\s*\(([^()]*)\)\s*$/dis;

  /**
   * Engines whose lastInsertId reports the FIRST generated id of a multi-row
   * INSERT rather than the last. Verified live, not assumed: a 3-row insert
   * into a fresh MySQL table reports 1 while MAX(id) is 3. SQLite, PostgreSQL
   * and MSSQL already report the last, so collapsing does not change them.
   */
  static readonly FIRST_ID_ENGINES: readonly string[] = ["mysql"];

  /**
   * Normalise a collapsed batch's last id to the LAST row's id.
   *
   * A row-at-a-time batch reports the last row's id simply because the last
   * statement inserted the last row. Collapsing rows into one statement changes
   * that on any engine that reports the FIRST generated id, so this restores
   * the contract instead of quietly redefining it. The ids in one statement are
   * consecutive, so the last is `first + rows - 1`.
   */
  static batchLastId(reportedId: unknown, rowsInChunk: number, engine: string): unknown {
    const lower = (engine ?? "").toLowerCase();
    const name = SQLTranslator.ENGINE_ALIASES[lower] ?? lower;
    if (!SQLTranslator.FIRST_ID_ENGINES.includes(name)) return reportedId;

    const n = typeof reportedId === "bigint" ? Number(reportedId) : Number(reportedId);
    if (reportedId === null || reportedId === undefined || Number.isNaN(n)) {
      return reportedId;                    // UUID/ULID key — no successor
    }
    return n + Math.max(rowsInChunk, 1) - 1;
  }

  /**
   * Collapse a row-at-a-time INSERT batch into chunked multi-row VALUES.
   *
   * A batch that loops one INSERT per row pays a full network round-trip per
   * row, and the round-trip — not SQL building — is the entire cost of a batch
   * write. Measured over 500 rows: PostgreSQL 9848ms row-at-a-time against
   * 15.8ms as a single multi-row statement (625x), MySQL 216x, MSSQL 121x.
   *
   * PURE: no I/O and no engine contact, so the chunking rules are checkable
   * without a database. The live-engine runners prove the rows land.
   *
   * @returns Statements to run INSTEAD of the loop, or an EMPTY array meaning
   *          "not collapsible — keep looping", which is always correct.
   */
  static buildBatchInserts(
    sql: string,
    paramSets: unknown[][],
    engine: string,
  ): Array<[string, unknown[]]> {
    const rows = paramSets ?? [];
    if (rows.length < 2) return [];

    const lower = (engine ?? "").toLowerCase();
    const name = SQLTranslator.ENGINE_ALIASES[lower] ?? lower;
    const cap = SQLTranslator.MAX_BIND_PARAMS[name] ?? 0;
    // Firebird has no multi-row VALUES syntax (verified against a live 5.0.4:
    // -104 Token unknown); ODBC's real ceiling depends on the driver behind it.
    // Emitting SQL the engine cannot parse to save a round-trip is not a trade
    // worth making.
    if (cap <= 0) return [];

    const upper = sql.toUpperCase();
    // A collapsed statement returns N rows where the caller expects one, and
    // conflict arbitration changes once rows share a statement.
    if (
      upper.includes("RETURNING") ||
      upper.includes("ON CONFLICT") ||
      upper.includes("ON DUPLICATE KEY")
    ) {
      return [];
    }

    const match = SQLTranslator.INSERT_VALUES.exec(sql);
    if (match === null) return [];

    // Every slot must be a bare placeholder. `now()` repeated per row inside one
    // statement is not the same write as `now()` evaluated per statement.
    const slots = match[1].split(",").map((s) => s.trim());
    if (slots.length === 0 || slots.some((s) => s !== "?")) return [];

    const columns = slots.length;
    if (rows.some((params) => params.length !== columns)) return [];

    const chunkRows = Math.max(1, Math.floor(cap / columns));
    if (chunkRows < 2) return [];

    const valuesStart = match.indices?.[1]?.[0];
    if (valuesStart === undefined) return [];
    const head = sql.slice(0, valuesStart - 1).trimEnd();
    const oneRow = `(${new Array(columns).fill("?").join(", ")})`;

    const statements: Array<[string, unknown[]]> = [];
    for (let start = 0; start < rows.length; start += chunkRows) {
      const chunk = rows.slice(start, start + chunkRows);
      const flat: unknown[] = [];
      for (const params of chunk) flat.push(...params);
      statements.push([`${head} ${new Array(chunk.length).fill(oneRow).join(", ")}`, flat]);
    }
    return statements;
  }

  /**
   * Blank out string literals, quoted identifiers and comments, so a keyword
   * search sees only real SQL. Blanks are spaces of the SAME LENGTH (newlines
   * preserved), so offsets and line structure still line up with the original.
   *
   * This exists because "does the caller's SQL already have a LIMIT?" used to be
   * `sql.toUpperCase().split("--")[0].includes("LIMIT")`, and MEASURED on a real
   * 150-row table with the 100-row cap in force, every one of these returned
   * ALL 150 ROWS instead of 100:
   *
   *     SELECT * FROM t WHERE label != 'LIMIT' ORDER BY id     -- literal
   *     SELECT * FROM t ORDER BY id -- LIMIT 5                 -- line comment
   *     SELECT * FROM t ORDER BY id /* LIMIT 5 *\/              -- block comment
   *
   * A column named `rate_limit` does it too. That is a silently UNCAPPED read of
   * a whole table, which is the exact production incident the row cap exists to
   * prevent, reachable through an ordinary column name.
   *
   * @param sql Raw SQL, exactly as the caller wrote it.
   * @returns The same string with literals and comments replaced by spaces.
   */
  static scrubSqlText(sql: string): string {
    let out = "";
    let i = 0;
    const blank = (ch: string): string => (ch === "\n" ? "\n" : " ");

    while (i < sql.length) {
      const c = sql[i];
      const next = sql[i + 1];

      // '...' string literal, with '' as the embedded-quote escape
      if (c === "'" || c === '"') {
        const quote = c;
        out += " ";
        i++;
        while (i < sql.length) {
          if (sql[i] === quote) {
            if (sql[i + 1] === quote) {
              out += "  ";
              i += 2;
              continue;
            }
            out += " ";
            i++;
            break;
          }
          out += blank(sql[i]);
          i++;
        }
        continue;
      }

      // -- line comment, to end of line
      if (c === "-" && next === "-") {
        while (i < sql.length && sql[i] !== "\n") {
          out += " ";
          i++;
        }
        continue;
      }

      // /* block comment */
      if (c === "/" && next === "*") {
        out += "  ";
        i += 2;
        while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
          out += blank(sql[i]);
          i++;
        }
        if (i < sql.length) {
          out += "  ";
          i += 2;
        }
        continue;
      }

      out += c;
      i++;
    }

    return out;
  }

  /**
   * True when the statement ENDS with its own LIMIT clause, so appending another
   * would be wrong (and on SQLite, a syntax error).
   *
   * Anchored to the END on purpose. A bare "contains LIMIT" test also matches a
   * LIMIT inside a subquery, where the OUTER statement still needs its cap. This
   * is tina4-php's `SqlNormalizerTrait::hasTrailingLimit` regex, ported verbatim
   * so all four frameworks answer identically: it accepts a numeric value, `?`,
   * `$1` and `:name` placeholders, MySQL's `LIMIT a, b`, and a trailing OFFSET.
   *
   * @param sql Raw SQL; literals and comments are scrubbed before matching.
   */
  static hasTrailingLimit(sql: string): boolean {
    const val = String.raw`(?:\d+|\?|\$\d+|:\w+|%s)`;
    const re = new RegExp(
      String.raw`\bLIMIT\s+${val}(?:\s*,\s*${val})?(?:\s+OFFSET\s+${val})?\s*;?\s*$`,
      "i",
    );
    return re.test(SQLTranslator.scrubSqlText(sql));
  }

  /**
   * Strip a trailing TOP-LEVEL `ORDER BY` so the statement can be wrapped in
   * `SELECT COUNT(*) FROM (<sql>) AS _count_query` for the row-count probe.
   *
   * SQL Server rejects an ORDER BY inside a derived table unless it carries
   * TOP/OFFSET/FETCH (error 1033), so the probe failed - and the total fell
   * back to the page length - for any read ending in ORDER BY. ORDER BY cannot
   * change a COUNT, so dropping it for the probe ONLY is safe; the paginated
   * query keeps it. An ORDER BY nested in a subquery, or one already legalised
   * by a following OFFSET/FETCH/FOR, is left intact. Positions are found on the
   * scrubbed text, so an `ORDER BY` inside a literal or comment is ignored.
   * Parity with Python `_strip_trailing_order_by` / PHP `stripTrailingOrderBy`.
   *
   * @param sql The read statement the probe is about to wrap.
   */
  static stripTrailingOrderBy(sql: string): string {
    const scrubbed = SQLTranslator.scrubSqlText(sql ?? "");
    const re = /\bORDER\s+BY\b/gi;
    let lastTopLevel = -1;
    for (let m = re.exec(scrubbed); m; m = re.exec(scrubbed)) {
      const before = scrubbed.slice(0, m.index);
      const balancedBefore = (before.match(/\(/g)?.length ?? 0) === (before.match(/\)/g)?.length ?? 0);
      let depth = 0;
      let balancedAfter = true;
      for (const ch of scrubbed.slice(m.index)) {
        if (ch === "(") depth++;
        else if (ch === ")" && --depth < 0) { balancedAfter = false; break; }
      }
      if (balancedBefore && balancedAfter) lastTopLevel = m.index;
    }
    if (lastTopLevel === -1) return sql;
    if (/\b(?:OFFSET|FETCH|FOR)\b/i.test(scrubbed.slice(lastTopLevel))) return sql;
    return sql.slice(0, lastTopLevel).trimEnd();
  }

  /**
   * True when the statement CHANGES data, even though it may return rows.
   *
   * fetch()/fetchOne() are the natural way to run a write that RETURNS rows
   * (`INSERT ... RETURNING id`, SQL Server's `OUTPUT inserted.id`), so they
   * cannot treat every statement as a read (tina4-python#133). A write is one
   * whose first word is a DML verb, or a `WITH` whose body holds one (a
   * data-modifying CTE ends in SELECT). The shared cross-framework contract:
   * a write through fetch/fetchOne runs exactly once, with no COUNT probe and
   * no LIMIT/OFFSET/ROWS/TOP pagination, is never cached, and commits like
   * execute(). Python's `_is_write_statement` answers identically.
   *
   * Literals and comments are scrubbed first, so `WHERE note = 'DELETE'` stays
   * a read. Erring towards "write" is the safe direction: a read misread as a
   * write only loses its pagination and cache for that one call.
   *
   * @param sql Raw SQL, exactly as the caller wrote it.
   */
  static isWriteStatement(sql: string): boolean {
    const scrubbed = SQLTranslator.scrubSqlText(sql ?? "").replace(/^[\s(]+/, "");
    const verb = (scrubbed.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
    if (["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"].includes(verb)) return true;
    if (verb === "WITH") return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(scrubbed);
    return false;
  }

  /**
   * Which kind of rows a statement produces, for execute() (cross-framework
   * contract): "read" (SELECT, WITH ... SELECT, VALUES, SHOW, EXPLAIN,
   * DESCRIBE), "returning" (a write with RETURNING, or SQL Server's OUTPUT
   * inserted./deleted.), "procedure" (CALL / EXEC / EXECUTE, which may return a
   * result set), or null for a statement that produces none. A data-modifying
   * CTE (WITH ... INSERT ... SELECT) produces rows too, so it is "read" here and
   * a write for isWriteStatement(). Literals and comments are scrubbed first.
   *
   * @param sql Raw SQL, exactly as the caller wrote it.
   */
  static rowsKind(sql: string): "read" | "returning" | "procedure" | null {
    const scrubbed = SQLTranslator.scrubSqlText(sql ?? "").replace(/^[\s(]+/, "");
    const verb = (scrubbed.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
    if (["SELECT", "WITH", "VALUES", "SHOW", "EXPLAIN", "DESCRIBE"].includes(verb)) return "read";
    if (["CALL", "EXEC", "EXECUTE"].includes(verb)) return "procedure";
    if (SQLTranslator.isWriteStatement(sql)
      && /\bRETURNING\b|\bOUTPUT\s+(INSERTED|DELETED)\./i.test(scrubbed)) return "returning";
    return null;
  }

  /**
   * Append `LIMIT`/`OFFSET` to a statement unless it already carries its own.
   *
   * The clause goes on a NEW LINE. Appending it inline is the second half of the
   * same bug: `SELECT * FROM t -- note` + ` LIMIT 100` puts the clause INSIDE the
   * trailing comment, where SQLite silently ignores it and the whole table comes
   * back. A newline cannot be commented out by a `--` that started on the line
   * above. Trailing semicolons are stripped first for the same reason
   * (`SELECT * FROM t;` + `LIMIT 100` is a syntax error).
   *
   * @param sql    The caller's statement.
   * @param limit  Row cap to apply; a non-positive value means "no cap".
   * @param offset Rows to skip; omitted or 0 emits no OFFSET.
   */
  static appendLimit(sql: string, limit?: number, offset?: number): string {
    if (limit === undefined || limit === null || limit <= 0) return sql;
    if (SQLTranslator.hasTrailingLimit(sql)) return sql;

    const trimmed = sql.replace(/[\s;]+$/, "");
    const suffix = offset !== undefined && offset > 0
      ? `LIMIT ${limit} OFFSET ${offset}`
      : `LIMIT ${limit}`;
    return `${trimmed}\n${suffix}`;
  }
}

// ── Query Cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  tags: string[];
}

/**
 * Simple in-memory query cache with TTL support.
 */
export class QueryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private defaultTtl: number;
  private maxSize: number;

  constructor(options?: { defaultTtl?: number; maxSize?: number }) {
    this.defaultTtl = options?.defaultTtl ?? 60;
    this.maxSize = options?.maxSize ?? 1000;
  }

  /**
   * Stable identity of the DATABASE a cache entry came from.
   *
   * `engine://host:port/database` - and deliberately NOTHING else.
   *
   * WHY IT EXISTS: the key used to be `query:${sql}:${params}` with nothing
   * naming the connection, so on any SHARED backend two databases cross-served
   * each other's rows. Two apps pointed at one Redis, or one app with a primary
   * and an analytics connection, silently read each other's data. Identical SQL
   * text across tenants is the COMMON case, not an edge case, so the collision
   * was the normal outcome.
   *
   * WHY NO CREDENTIALS: a password in the key means every rotation silently
   * cold-starts the cache, and a shared backend's key namespace is visible to
   * every tenant of that backend - a secret must never be folded into it. The
   * username is out for the same reason plus a second: two connections
   * differing only by role read the SAME rows and should share the entry.
   *
   * WHY NOTHING PER-PROCESS: no pid, no object id, no salt. Those would isolate
   * the databases by ACCIDENT and destroy the point of a shared cache, because
   * no instance would ever hit another instance's entry.
   */
  static cacheIdentity(url: string): string {
    try {
      const parsed = new DatabaseUrl(url);
      return `${parsed.engine}://${parsed.host ?? ""}:${parsed.port ?? ""}/${parsed.database}`;
    } catch {
      // An unparseable URL still needs a STABLE identity, and falling back to a
      // constant would silently restore the cross-serving bug. The raw URL is
      // stable and distinct; it is only reached for a URL the connection layer
      // is about to reject anyway.
      return url;
    }
  }

  /**
   * Generate a cache key from DATABASE IDENTITY + SQL + params.
   *
   * The NUL separators keep the three parts from running together, so a table
   * named after the tail of a database name cannot forge another database's
   * key. The key is not hashed here: the only backend with a key-length limit
   * is memcached, and its backend already SHA-256-hashes whatever it is given.
   */
  static queryKey(sql: string, params?: unknown[], identity = ""): string {
    const paramStr = params ? JSON.stringify(params) : "";
    return `query:${identity}\u0000${sql}\u0000${paramStr}`;
  }


  /**
   * Get a cached value. Returns undefined if expired or missing.
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a cached value with optional TTL (seconds) and tags for grouped
   * invalidation via clearTag().
   */
  set<T>(key: string, value: T, ttl?: number, tags: string[] = []): void {
    // Evict oldest entry if at max size
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? this.defaultTtl) * 1000,
      tags,
    });
  }

  /**
   * Remove all entries that carry the given tag. Returns the number removed.
   */
  clearTag(tag: string): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.tags.includes(tag)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key.
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Remove all expired entries.
   */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the number of cached entries.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Get or set a value using a factory function.
   */
  remember<T>(key: string, ttl: number, factory: () => T): T {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = factory();
    this.set(key, value, ttl);
    return value;
  }
}

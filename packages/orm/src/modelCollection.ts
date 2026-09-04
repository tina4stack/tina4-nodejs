/**
 * ModelCollection — a list of ORM models that also carries the query total.
 *
 * What the ORM read queries (`where` / `select` / `find` filter-form / `all` /
 * `withTrashed`) return. It IS an Array — iterate it, index it, slice it, `.map`
 * it, `.filter` it, read `.length`, `JSON.stringify` it — so every existing
 * caller keeps working unchanged (`Array.isArray(coll) === true`). It adds one
 * thing: the TOTAL number of rows matching the query's filter, independent of
 * `limit` / `offset`.
 *
 * The total is free. Every one of those methods already runs the fetch COUNT
 * probe (`db.fetch` / `probeTotal`) that computes `SELECT COUNT(*)` for the same
 * filter; the ORM used to hydrate the page of models and throw that count away.
 * This class carries it instead, so a caller with 20 models on the page can
 * still learn there are 250 rows in the set. ZERO extra queries.
 *
 * Uniform across all four Tina4 frameworks (ADR-0064). Same concept, language-
 * idiomatic accessor name:
 *
 *     Python / Ruby : get_total_records()   to_paginate()
 *     PHP / Node    : getTotalRecords()     toPaginate()
 *
 * The accessor is a METHOD, not a `.total` property, on purpose: `Array#count`
 * exists in Ruby and `list.count()` in Python, so a `.count` would shadow a
 * built-in. `DatabaseResult` keeps its `.count` property (it is not a list); both
 * expose the identical seven-key `toPaginate()` envelope.
 *
 * ### Why a real Array subclass with `[Symbol.species] === Array`
 *
 * `class X extends Array` is the parity-faithful backing (the ADR-0064 table
 * says Node is a "subclass of Array"), and it keeps `Array.isArray` true and
 * `instanceof ModelCollection` true (mirroring Python's `isinstance`). BUT a bare
 * Array subclass is a footgun: `map`/`filter`/`slice` build the result via
 * `this.constructor[Symbol.species]`, calling the constructor with a single
 * NUMBER (the length), and `new X(oneNumber)` means "length N", not "one
 * element". Overriding `[Symbol.species]` to return `Array` makes every derived
 * operation build a plain `Array` — so `.map`/`.filter`/`.slice`/spread never
 * touch this constructor and can never explode. The constructor below is also
 * defended against the numeric-length call directly, so even a path that ignores
 * species is safe.
 */

/** The canonical pagination envelope — seven snake_case keys (ADR-0043/0064). */
export interface PaginateEnvelope {
  records: unknown[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
  limit: number;
  offset: number;
}

export class ModelCollection<T = unknown> extends Array<T> {
  /** Total rows matching the query's filter (ignores limit/offset). */
  private _total = 0;
  /** The SQL limit that produced this page. */
  private _limit = 0;
  /** The SQL offset that produced this page. */
  private _offset = 0;

  /**
   * Derived array operations (`map`, `filter`, `slice`, spread, …) build a plain
   * `Array`, never another `ModelCollection`. This is what defuses the Array-
   * subclass constructor/species trap: the engine never calls this constructor
   * with a length during those operations.
   */
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /**
   * @param items  the page of hydrated model instances (or the length, when the
   *               engine constructs a derived array — defended against here).
   * @param total  total rows matching the query's filter (ignores limit/offset).
   * @param limit  the SQL limit that produced this page.
   * @param offset the SQL offset that produced this page.
   */
  constructor(items?: readonly T[] | number, total = 0, limit = 0, offset = 0) {
    super();
    // Defensive: a raw `new ModelCollection(5)` (or any engine path that ignores
    // [Symbol.species]) must behave like `new Array(5)` — a length-5 array — not
    // wedge a number into element 0. `[Symbol.species] = Array` means the built-
    // in derived ops never reach here, but this keeps the constructor honest.
    if (typeof items === "number") {
      this.length = items;
      return;
    }
    if (items) {
      for (let i = 0; i < items.length; i++) {
        this[i] = items[i];
      }
    }
    this._total = Math.trunc(total) || 0;
    this._limit = Math.trunc(limit) || 0;
    this._offset = Math.trunc(offset) || 0;
  }

  /**
   * Total rows matching the query's filter, ignoring limit/offset.
   *
   * This is the whole point of the collection: the page slice you are iterating
   * is capped by `limit`, but this number is the full count of matching rows —
   * what a pager needs to render "page 3 of 13".
   */
  getTotalRecords(): number {
    return this._total;
  }

  /**
   * The canonical pagination envelope — seven snake_case keys, identical to
   * `DatabaseResult.toPaginate()` (ADR-0043) and to the other three frameworks'
   * `toPaginate()` / `to_paginate()`.
   *
   *     records     the page's rows as plain objects (never re-sliced)
   *     total       getTotalRecords() — the true total for the filter
   *     page        floor(offset / per_page) + 1
   *     per_page    the query's limit
   *     total_pages ceil(total / per_page)
   *     limit       the SQL limit actually applied
   *     offset      the SQL offset actually applied
   *
   * `records` are model dicts (via `toDict()`, the same serialisation the
   * framework applies to a model in a JSON response), so the JSON a client sees
   * matches `DatabaseResult` exactly — the result is uniform whether the route
   * returned a raw `db.fetch()` or an ORM query.
   */
  toPaginate(): PaginateEnvelope {
    const perPage = this._limit > 0 ? this._limit : this.length;
    const page = perPage > 0 ? Math.floor(this._offset / perPage) + 1 : 1;
    const totalPages = perPage > 0 ? Math.max(1, Math.ceil(this._total / perPage)) : 1;
    // `.map` returns a plain Array here (see [Symbol.species]). Each model is
    // serialised via toDict() — the same shape the framework emits for a model
    // in a JSON response — so the envelope matches DatabaseResult exactly.
    const records = this.map((model) => {
      const m = model as unknown as { toDict?: () => unknown };
      return m && typeof m.toDict === "function" ? m.toDict() : model;
    });
    return {
      records,
      total: this._total,
      page,
      per_page: perPage,
      total_pages: totalPages,
      limit: perPage,
      offset: this._offset,
    };
  }
}

export const DEFAULT_SRID = 4326;

export class SpatialNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialNotSupportedError";
  }
}

export type GeoJsonPoint = { type: "Point"; coordinates: [number, number] };

/** Immutable SRID-aware longitude/latitude point (ADR-0057). */
export class Point {
  readonly lon: number;
  readonly lat: number;
  readonly srid: number;

  constructor(lon: unknown, lat: unknown, srid: unknown = DEFAULT_SRID) {
    if (typeof lon === "boolean" || typeof lat === "boolean" || typeof srid === "boolean") {
      throw new TypeError("Point longitude, latitude and SRID must be numbers");
    }
    this.lon = Number(lon);
    this.lat = Number(lat);
    this.srid = Number(srid);
    if (!Number.isFinite(this.lon) || !Number.isFinite(this.lat) || !Number.isInteger(this.srid)) {
      throw new TypeError("Point longitude and latitude must be finite numbers and SRID must be an integer");
    }
    if (this.srid === DEFAULT_SRID) {
      if (this.lon < -180 || this.lon > 180) throw new RangeError(`Point longitude ${this.lon} is outside -180..180; Tina4 uses longitude, latitude order`);
      if (this.lat < -90 || this.lat > 90) throw new RangeError(`Point latitude ${this.lat} is outside -90..90; Tina4 uses longitude, latitude order`);
    }
    Object.freeze(this);
  }

  get wkt(): string { return `POINT(${formatCoordinate(this.lon)} ${formatCoordinate(this.lat)})`; }
  get ewkt(): string { return `SRID=${this.srid};${this.wkt}`; }
  get geojson(): GeoJsonPoint { return { type: "Point", coordinates: [this.lon, this.lat] }; }
  toJSON(): GeoJsonPoint { return this.geojson; }
  toArray(): [number, number] { return [this.lon, this.lat]; }

  static parse(value: unknown, srid = DEFAULT_SRID): Point {
    if (value instanceof Point) return value;
    if (Array.isArray(value)) {
      if (value.length < 2) throw new TypeError("Point coordinate pair needs longitude and latitude");
      return new Point(value[0], value[1], srid);
    }
    if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
      return Point.fromGeoJson(value as Record<string, unknown>, srid);
    }
    if (value instanceof Uint8Array) return Point.fromWkb(value, srid);
    if (typeof value === "string") {
      const text = value.trim();
      const match = /^(?:SRID\s*=\s*(\d+)\s*;\s*)?POINT\s*(?:Z|M|ZM)?\s*\(\s*([-+0-9.eE]+)\s+([-+0-9.eE]+)(?:\s+[-+0-9.eE]+)*\s*\)$/i.exec(text);
      if (match) return new Point(match[2], match[3], match[1] ? Number(match[1]) : srid);
      if (text.length >= 42 && text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text)) {
        return Point.fromWkb(Uint8Array.from(Buffer.from(text, "hex")), srid);
      }
    }
    throw new TypeError("Point must be Point, [longitude, latitude], WKT/EWKT, GeoJSON or WKB/EWKB");
  }

  static geometryBinding(value: unknown, srid = DEFAULT_SRID): [string, "ewkt" | "geojson"] {
    if (value instanceof Point || Array.isArray(value)) return [Point.parse(value, srid).ewkt, "ewkt"];
    if (value && typeof value === "object") {
      const candidate = value as Record<string, unknown>;
      const geometry = String(candidate.type).toLowerCase() === "feature"
        ? candidate.geometry as Record<string, unknown> : candidate;
      const allowed = new Set(["point", "linestring", "polygon", "multipoint", "multilinestring", "multipolygon", "geometrycollection"]);
      if (!geometry || !allowed.has(String(geometry.type).toLowerCase())) throw new TypeError("GeoJSON geometry has an unsupported type");
      return [JSON.stringify(geometry), "geojson"];
    }
    if (typeof value === "string" && /^\s*(?:SRID\s*=\s*\d+\s*;\s*)?(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i.test(value)) {
      return [/^\s*SRID/i.test(value) ? value.trim() : `SRID=${srid};${value.trim()}`, "ewkt"];
    }
    throw new TypeError("Geometry must be Point, coordinate pair, WKT/EWKT or GeoJSON");
  }

  private static fromGeoJson(data: Record<string, unknown>, srid: number): Point {
    const geometry = String(data.type).toLowerCase() === "feature"
      ? data.geometry as Record<string, unknown> : data;
    if (!geometry || String(geometry.type).toLowerCase() !== "point") throw new TypeError("Point GeoJSON type must be Point");
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) throw new TypeError("Point GeoJSON coordinates must be [longitude, latitude]");
    return new Point(coordinates[0], coordinates[1], srid);
  }

  private static fromWkb(raw: Uint8Array, srid: number): Point {
    if (raw.byteLength < 21) throw new TypeError("Point WKB is too short");
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const little = raw[0] === 1;
    const typeWord = view.getUint32(1, little);
    let offset = 5;
    if ((typeWord & 0x20000000) !== 0) {
      srid = view.getUint32(5, little);
      offset = 9;
    }
    const code = (typeWord & ~(0x20000000 | 0x40000000 | 0x80000000)) % 1000;
    if (code !== 1 || raw.byteLength < offset + 16) throw new TypeError("WKB geometry is not a Point");
    return new Point(view.getFloat64(offset, little), view.getFloat64(offset + 8, little), srid);
  }
}

function formatCoordinate(value: number): string {
  return Object.is(value, -0) ? "0" : Number(value.toPrecision(15)).toString();
}

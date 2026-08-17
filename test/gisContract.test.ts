import {
  BaseModel, Point, SQLTranslator,
  createAdapterFromUrl, setAdapter, adapterExecute, adapterFetchOne,
} from "../packages/orm/src/index.ts";
import type { FieldDefinition } from "../packages/orm/src/index.ts";
import { readFileSync } from "node:fs";
import net from "node:net";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}
function throws(name: string, fn: () => unknown, pattern?: RegExp): void {
  try { fn(); assert(name, false, "did not throw"); }
  catch (error) { assert(name, !pattern || pattern.test(String((error as Error).message)), String(error)); }
}

class GisFixtureSite extends BaseModel {
  static tableName = "gis_fixture_site";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    location: { type: "point", srid: 4326, spatialIndex: true },
  };
}

const capeTown: [number, number] = [18.4241, -33.9249];
const contract = JSON.parse(readFileSync(new URL("./fixtures/gis_contract.json", import.meta.url), "utf8"));
assert("byte-identical shared fixture loads", contract.adr === "ADR-0057" && contract.defaults.coordinate_order.join(",") === "longitude,latitude");
const forms: unknown[] = [
  capeTown,
  "POINT(18.4241 -33.9249)",
  "SRID=4326;POINT(18.4241 -33.9249)",
  { type: "Point", coordinates: capeTown },
  { type: "Feature", geometry: { type: "Point", coordinates: capeTown }, properties: {} },
];
assert("accepted forms normalize to one Point", forms.every((form) => JSON.stringify(Point.parse(form).geojson) === JSON.stringify({ type: "Point", coordinates: capeTown })));

const ewkb = Point.parse("0101000020E6100000CD3B4ED1916C324003098A1F63F640C0");
assert("PostGIS EWKB parses", ewkb.lon.toFixed(4) === "18.4241" && ewkb.lat.toFixed(4) === "-33.9249" && ewkb.srid === 4326);

for (const [name, value] of [["latitude", [18, 91]], ["longitude", [181, -33]], ["boolean", [true, -33]], ["short", [18]]] as const) {
  throws(`invalid ${name} fails before SQL`, () => new GisFixtureSite({ location: value }));
}
throws("mismatched SRID fails before SQL", () => new GisFixtureSite({ location: "SRID=3857;POINT(1 2)" }), /expects SRID 4326/);

assert("PostGIS predicate uses bound placeholders", SQLTranslator.withinDistance("postgres", "location") === "ST_DWithin(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)");
throws("unsafe spatial identifiers fail", () => SQLTranslator.distance("postgres", "location; DROP TABLE sites"));
throws("SQLite spatial behavior fails loudly", () => SQLTranslator.pointColumnType("sqlite"), /PostGIS-first/);

const first = new GisFixtureSite({ id: 1, name: "Cape Town", location: capeTown });
const second = new GisFixtureSite({ id: 2, name: "Johannesburg", location: [28.0473, -26.2041] });
const feature = first.toFeature();
assert("Feature is RFC 7946 shaped", JSON.stringify(feature) === JSON.stringify({ type: "Feature", geometry: { type: "Point", coordinates: capeTown }, properties: { id: 1, name: "Cape Town" } }), JSON.stringify(feature));
const collection = GisFixtureSite.featureCollection([second, first]) as { features: Array<{ properties: { id: number } }> };
assert("FeatureCollection preserves order", collection.features.map((item) => item.properties.id).join(",") === "2,1");

const postgisUrl = process.env.TINA4_TEST_POSTGIS_URL ?? "postgres://tina4:tina4@127.0.0.1:55433/tina4_gis";
const parsed = new URL(postgisUrl);
const reachable = await new Promise<boolean>((resolve) => {
  const socket = net.createConnection(Number(parsed.port || 5432), parsed.hostname);
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once("error", () => { clearTimeout(timer); resolve(false); });
});
if (!reachable) {
  console.log(`  SKIP real PostGIS fixture — PostGIS not reachable at ${parsed.hostname}:${parsed.port || 5432}`);
} else {
  const adapter = await createAdapterFromUrl(postgisUrl);
  setAdapter(adapter);
  try {
    await adapterExecute(adapter, "CREATE EXTENSION IF NOT EXISTS postgis");
    await adapterExecute(adapter, "DROP TABLE IF EXISTS gis_fixture_site");
    assert("real PostGIS DDL succeeds", await GisFixtureSite.createTable());
    assert("real PostGIS DDL/index is idempotent", await GisFixtureSite.createTable());
    const column = await adapterFetchOne<{ type: string; srid: number }>(adapter, "SELECT type, srid FROM geography_columns WHERE f_table_name = ? AND f_geography_column = ?", ["gis_fixture_site", "location"]);
    assert("real geography(Point,4326) exists", column?.type === "Point" && Number(column.srid) === 4326, JSON.stringify(column));
    for (const [key, name] of Object.entries({ cape_town: "Cape Town", johannesburg: "Johannesburg", anti_east: "Anti East", anti_west: "Anti West" })) {
      assert(`real PostGIS saves ${name}`, Boolean(await new GisFixtureSite({ name, location: contract.points[key] }).save()));
    }
    const near = await GisFixtureSite.query().withinDistance("location", contract.points.cape_town, 1000).orderByDistance("location", contract.points.cape_town).get();
    assert("real radius/order query", near.records.map((row) => row.name).join(",") === "Cape Town", JSON.stringify(near.records));
    const distance = await GisFixtureSite.query().select("name").selectDistance("location", contract.points.cape_town, "metres").where("name = ?", ["Johannesburg"]).first<{ metres: number }>();
    assert("real spheroid distance is metres", Number(distance?.metres) >= 1250000 && Number(distance?.metres) <= 1275000, JSON.stringify(distance));
    const boxed = await GisFixtureSite.query().bbox("location", ...contract.bbox_cases[0].bounds).get();
    assert("real bbox query", boxed.records.map((row) => row.name).join(",") === "Cape Town", JSON.stringify(boxed.records));
    const loaded = await GisFixtureSite.findById<GisFixtureSite>(1);
    assert("real PostGIS hydration returns Point", loaded?.location instanceof Point);
  } finally {
    await adapterExecute(adapter, "DROP TABLE IF EXISTS gis_fixture_site");
    adapter.close();
  }
}

console.log(`\nGIS contract: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;

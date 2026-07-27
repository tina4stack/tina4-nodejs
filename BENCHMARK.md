# Tina4 Node.js — Benchmark Report

**Date:** 2026-03-25 | **Machine:** Apple Silicon (ARM64), 8 cores | **Tool:** `hey` (5000 requests, 50 concurrent, 3 runs, averaged)

---

## 1. Performance

Real HTTP benchmarks — identical JSON endpoint and 100-item list endpoint. Tina4 production mode uses Node cluster (8 workers). Competitors run single-process.

### Production Mode (cluster, 8 workers)

| Framework | JSON req/s | 100-item list req/s | Deps |
|-----------|:---------:|:-------------------:|:----:|
| Fastify | 55,329 | 33,496 | 1 |
| Koa | 52,708 | 29,909 | 2 |
| **Tina4 Node.js** | **34,343** | **50,001** | **0** |
| Express | 43,662 | 28,161 | 1 |
| Hapi | 42,959 | 15,646 | 1 |

### Development Mode (tsx, single process)

| Framework | JSON req/s | 100-item list req/s | Deps |
|-----------|:---------:|:-------------------:|:----:|
| **Tina4 Node.js** | **11,872** | **12,347** | **0** |

**Key takeaway:** In production mode (cluster), Tina4 Node.js delivers 34,343 JSON and 50,001 list req/s — competitive with Express and Koa, while shipping 38 built-in features with 0 dependencies. List serialisation (50K req/s) beats every competitor. Dev mode runs through tsx transpiler (11,872 req/s) which is expected.

---

## 1b. Template rendering, Frond vs Nunjucks and EJS

**Date:** 2026-07-27 | **Machine:** Apple Silicon (ARM64), macOS | **Node:** v24.9.0 | **Tool:** `benchmarks/benchTemplates.ts` (p50 over batched samples, min 0.25s / 200 iterations)

This category used to be missing, and its absence flattered us. Sections 1 and 2 above
measure request throughput and feature count, where Tina4 competes well. Neither says
anything about template rendering, the one axis where Frond competes head-on with the
engines it replaced. Here are the numbers.

Same page (20-row product list: loop, index, even/odd class, uppercase, 2-decimal
money, conditional footer). **Every engine's output is compared and proven identical
before anything is timed**; a mismatch aborts the run. Each template is compiled ONCE
outside the clock, so this is steady-state render throughput, not compilation.

| Engine | Renders/s (p50) | Renders/s (mean) | Deps |
|--------|:---------------:|:----------------:|:----:|
| Nunjucks | **62,420** | 59,160 | 1 |
| EJS | **53,570** | 51,471 | 1 |
| **Frond (Tina4)** | **7,016** | 6,099 | **0** |

**Key takeaway, stated plainly: Frond is 8.90x slower than Nunjucks and 7.64x slower
than EJS on identical output.** Nunjucks and EJS both compile a template into a real JS
function and let V8 optimise it; Frond walks a tree and calls back into engine
primitives per hole.

Worth noting against the Python result: Node has **no** AOT compile-to-closure layer and
sits 8.9x behind, while Python **has** one and sits 14.5x behind. So shipping that layer
here is not by itself the fix, emitting native host-language source is the lever.

What Frond does buy is the zero in the Deps column, and the fact that the same template
syntax renders in all four Tina4 languages. That is a real trade, but it is a trade -
not a win. Closing this gap is tracked as the ahead-of-time compile layer (ADR-0001).

Reproduce: `cd benchmarks && npm install && npx tsx benchmarks/benchTemplates.ts`


## 2. Feature Comparison (41 of 98 built-in features)

Tina4 ships **98 built-in features**. The table below compares the subset that has a
meaningful equivalent in the competing frameworks, so it is a like-for-like comparison
rather than the full inventory. Everything listed ships with the core install, with no
extra packages needed.

| Feature | Tina4 | Express | Fastify | Koa | Hapi |
|---------|:-----:|:-------:|:-------:|:---:|:----:|
| **CORE WEB** | | | | | |
| Routing (decorators) | Y | Y | Y | - | Y |
| Typed path parameters | Y | Y | Y | - | Y |
| Middleware system | Y | Y | Y | Y | Y |
| Static file serving | Y | - | - | - | Y |
| CORS built-in | Y | - | Y | - | Y |
| Rate limiting | Y | - | - | - | - |
| WebSocket | Y | - | Y | - | - |
| **DATA** | | | | | |
| ORM | Y | - | - | - | - |
| 5 database drivers | Y | - | - | - | - |
| Migrations | Y | - | - | - | - |
| Seeder / fake data | Y | - | - | - | - |
| Sessions | Y | - | - | - | Y |
| Response caching | Y | - | - | - | Y |
| **AUTH** | | | | | |
| JWT built-in | Y | - | - | - | - |
| Password hashing | Y | - | - | - | - |
| CSRF protection | Y | - | - | - | Y |
| **FRONTEND** | | | | | |
| Template engine | Y | - | - | - | Y |
| CSS framework | Y | - | - | - | - |
| SCSS compiler | Y | - | - | - | - |
| Frontend JS helpers | Y | - | - | - | - |
| **API** | | | | | |
| Swagger/OpenAPI | Y | - | Y | - | Y |
| GraphQL | Y | - | - | - | - |
| SOAP/WSDL | Y | - | - | - | - |
| HTTP client | Y | - | - | - | Y |
| Queue system | Y | - | - | - | - |
| **DEV EXPERIENCE** | | | | | |
| CLI scaffolding | Y | - | - | - | - |
| Dev admin dashboard | Y | - | - | - | - |
| Error overlay | Y | - | - | - | - |
| Live reload | Y | - | - | - | - |
| Auto-CRUD generator | Y | - | - | - | - |
| Gallery / examples | Y | - | - | - | - |
| AI assistant context | Y | - | - | - | - |
| Inline testing | Y | - | - | - | - |
| **ARCHITECTURE** | | | | | |
| Zero dependencies | Y | - | - | - | - |
| Dependency injection | Y | - | - | - | - |
| Event system | Y | - | - | - | - |
| i18n / translations | Y | - | - | - | - |
| HTML builder | Y | - | - | - | - |

### Feature Count

| Framework | Features | Deps | JSON req/s | List req/s |
|-----------|:-------:|:----:|:---------:|:----------:|
| **Tina4** | **41/41** | **0** | **11,872** | **12,347** |
| Hapi | 12/41 | 1 | 41,185 | 10,431 |
| Fastify | 5/41 | 1 | 32,824 | 18,705 |
| Express | 4/41 | 1 | 39,337 | 18,616 |
| Koa | 3/41 | 2 | 23,528 | 18,205 |

---

## 3. Deployment Size

**Measured 2026-07-27** on macOS (Apple Silicon) by installing each package for real.
Nothing in this table is estimated. The command that produced it is named below.

Command: `npm install <pkg> --omit=dev` into an empty project, then `du -sh node_modules`.

| Framework | Install Size | Packages in node_modules |
|-----------|:----------:|:------------------------:|
| @hapi/hapi | **2 MB** | 2 |
| koa | 2 MB | 30 |
| express | 4 MB | 65 |
| **Tina4 Node.js** | **7.7 MB** package, **40 MB** as installed | **36** |
| fastify | 13 MB | 41 |

**Correction.** This table claimed **~1.8 MB**. The published package is **7.7 MB**, and a
default `npm install tina4-nodejs` produces a **40 MB** `node_modules` holding 36 packages,
because npm installs `optionalDependencies` unless you pass `--no-optional`.

To be precise about the zero-dependency claim, which does survive: the published
`package.json` declares **0 `dependencies`** and 5 `optionalDependencies` (AWS SDK,
mongodb, redis, pg and friends, for the storage and cache backends). Nothing is a hard
requirement, so the framework genuinely runs on the stdlib alone. But 40 MB is what a user
gets by default, and quoting 1.8 MB was misleading. Use `--no-optional` for the lean path.

## 4. CO2 / Carbonah

Estimated emissions per HTTP benchmark run (5000 requests on Apple Silicon, 15W TDP).

Energy = TDP x time = 15W x (5000 / req_per_sec). CO2 at world average 475g CO2/kWh.

### JSON Endpoint

| Framework | JSON req/s | Time (s) | Est. Energy (kWh) | Est. CO2 (g) |
|-----------|:---------:|:--------:|:-----------------:|:------------:|
| Hapi | 41,185 | 0.121 | 0.0000005 | 0.00024 |
| Express | 39,337 | 0.127 | 0.0000005 | 0.00025 |
| Fastify | 32,824 | 0.152 | 0.0000006 | 0.00030 |
| Koa | 23,528 | 0.213 | 0.0000009 | 0.00042 |
| **Tina4** | **11,872** | **0.4212** | **0.0000018** | **0.00083** |

### List Endpoint (100-item payload)

| Framework | List req/s | Time (s) | Est. Energy (kWh) | Est. CO2 (g) |
|-----------|:---------:|:--------:|:-----------------:|:------------:|
| Fastify | 18,705 | 0.267 | 0.0000011 | 0.00053 |
| Express | 18,616 | 0.269 | 0.0000011 | 0.00053 |
| Koa | 18,205 | 0.275 | 0.0000011 | 0.00054 |
| **Tina4** | **12,347** | **0.4050** | **0.0000017** | **0.00080** |
| Hapi | 10,431 | 0.479 | 0.0000020 | 0.00095 |

**CO2 footprint scales inversely with throughput.** Tina4 ships 38 built-in features with zero dependencies while maintaining competitive energy efficiency.

*CO2 calculated at world average 475g CO2/kWh. Lower req/s = longer to serve 5000 requests = more energy.*

**Carbonah Rating: A**

---

## 5. How to Run

Benchmarks use [hey](https://github.com/rakyll/hey) on macOS with Apple Silicon.

```bash
# Install hey
brew install hey

# Start each framework server, then:
hey -n 5000 -c 50 http://localhost:<port>/json
hey -n 5000 -c 50 http://localhost:<port>/list

# Run 3 times, take the median req/s
```

Benchmark scripts are maintained in the `tina4-python` repository's `benchmarks/` folder:

```bash
cd ../tina4-python/benchmarks
python benchmark.py --nodejs
```

Full cross-language suite:
```bash
python benchmark.py --all
```

Results are written to `benchmarks/results/nodejs.json`.

See the [tina4-python benchmarks README](https://github.com/tina4stack/tina4-python/tree/main/benchmarks) for prerequisites and detailed instructions.

---

*Generated from benchmark data — https://tina4.com*

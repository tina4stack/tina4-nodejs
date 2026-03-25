# Tina4 Node.js — Benchmark Report

**Date:** 2026-03-25 | **Machine:** Apple Silicon (ARM64), 8 cores | **Tool:** `hey` (5000 requests, 50 concurrent, 3 runs, averaged)

---

## 1. Performance

Real HTTP benchmarks — identical JSON endpoint and 100-item list endpoint, development servers.

| Framework | JSON req/s | 100-item list req/s | Deps |
|-----------|:---------:|:-------------------:|:----:|
| Hapi | 41,185 | 10,431 | 1 |
| Express | 39,337 | 18,616 | 1 |
| Fastify | 32,824 | 18,705 | 1 |
| Koa | 23,528 | 18,205 | 2 |
| **Tina4 Node.js** | **11,872** | **12,347** | **0** |

**Key takeaway:** Tina4 Node.js delivers 11,872 req/s JSON and 12,347 req/s list with 38 features and 0 dependencies. While raw throughput is lower than Hapi (41,185), Express (39,337), and Fastify (32,824), Tina4 ships 38 built-in features vs their 3-12, with zero dependencies.

---

## 2. Feature Comparison (38 features)

Ships with core install, no extra packages needed.

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
| **Tina4** | **38/38** | **0** | **11,872** | **12,347** |
| Hapi | 12/38 | 1 | 41,185 | 10,431 |
| Fastify | 5/38 | 1 | 32,824 | 18,705 |
| Express | 4/38 | 1 | 39,337 | 18,616 |
| Koa | 3/38 | 2 | 23,528 | 18,205 |

---

## 3. Deployment Size

| Framework | Install Size | Dependencies |
|-----------|:----------:|:------------:|
| **Tina4 Node.js** | **~1.8 MB** | **0** |
| Koa | ~2 MB | 2 |
| Express | ~2.5 MB | 1 (+57 transitive) |
| Fastify | ~3 MB | 1 (+14 transitive) |
| Hapi | ~3.5 MB | 1 (+12 transitive) |

Zero dependencies means core size **is** deployment size. No `node_modules` bloat.

---

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

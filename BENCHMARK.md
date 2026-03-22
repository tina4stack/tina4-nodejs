# Tina4 Node.js — Benchmark Report

**Date:** 2026-03-22 | **Machine:** Apple Silicon (ARM64) | **Tool:** `hey` (5000 requests, 50 concurrent, 3 runs, median)

---

## 1. Performance

Real HTTP benchmarks — identical JSON endpoint, development servers.

| Framework | JSON req/s | 100-item list req/s | Server | Deps |
|-----------|:---------:|:-------------------:|--------|:----:|
| Node.js raw http | 85,094 | 24,985 | http | 0 |
| Fastify | 55,361 | 19,286 | http | 10 |
| **Tina4 Node.js 3.1** | **78,422** | **23,982** | **http** | **0** |
| Koa | 48,529 | 22,137 | http | 5 |
| Express 5 | 43,343 | 18,579 | http | 3 |

**Key takeaway:** Tina4 is within 8% of Fastify on JSON and beats it on list payloads — while shipping 38 features with 0 dependencies. Express with only 4 features is 15% slower.

### Warmup Time

| Framework | Warmup (ms) |
|-----------|:-----------:|
| Node.js raw | 24 |
| Koa | 37 |
| Fastify | 39 |
| **Tina4** | **46** |
| Express | 128 |

---

## 2. Feature Comparison (38 features)

Ships with core install, no extra packages needed.

| Feature | Tina4 | Express | Fastify | Koa |
|---------|:-----:|:-------:|:-------:|:---:|
| **CORE WEB** | | | | |
| Routing (decorators) | Y | Y | Y | - |
| Typed path parameters | Y | Y | Y | - |
| Middleware system | Y | Y | Y | Y |
| Static file serving | Y | - | - | - |
| CORS built-in | Y | - | Y | - |
| Rate limiting | Y | - | - | - |
| WebSocket | Y | - | Y | - |
| **DATA** | | | | |
| ORM | Y | - | - | - |
| 5 database drivers | Y | - | - | - |
| Migrations | Y | - | - | - |
| Seeder / fake data | Y | - | - | - |
| Sessions | Y | - | - | - |
| Response caching | Y | - | - | - |
| **AUTH** | | | | |
| JWT built-in | Y | - | - | - |
| Password hashing | Y | - | - | - |
| CSRF protection | Y | - | - | - |
| **FRONTEND** | | | | |
| Template engine | Y | - | - | - |
| CSS framework | Y | - | - | - |
| SCSS compiler | Y | - | - | - |
| Frontend JS helpers | Y | - | - | - |
| **API** | | | | |
| Swagger/OpenAPI | Y | - | Y | - |
| GraphQL | Y | - | - | - |
| SOAP/WSDL | Y | - | - | - |
| HTTP client | Y | - | - | - |
| Queue system | Y | - | - | - |
| **DEV EXPERIENCE** | | | | |
| CLI scaffolding | Y | - | - | - |
| Dev admin dashboard | Y | - | - | - |
| Error overlay | Y | - | - | - |
| Live reload | Y | - | - | - |
| Auto-CRUD generator | Y | - | - | - |
| Gallery / examples | Y | - | - | - |
| AI assistant context | Y | - | - | - |
| Inline testing | Y | - | - | - |
| **ARCHITECTURE** | | | | |
| Zero dependencies | Y | - | - | - |
| Dependency injection | Y | - | - | - |
| Event system | Y | - | - | - |
| i18n / translations | Y | - | - | - |
| HTML builder | Y | - | - | - |

### Feature Count

| Framework | Features | Deps | JSON req/s |
|-----------|:-------:|:----:|:---------:|
| **Tina4** | **38/38** | **0** | **51,111** |
| Fastify | 5/38 | 10 | 55,361 |
| Express | 4/38 | 3 | 43,343 |
| Koa | 3/38 | 5 | 48,529 |
| raw http | 1/38 | 0 | 85,094 |

---

## 3. Deployment Size

| Framework | Install Size | Dependencies |
|-----------|:----------:|:------------:|
| **Tina4 Node.js** | **1.8 MB** | **0** |
| Express | 2 MB | 3 |
| Fastify | 2 MB | 10 |
| Koa | 1.5 MB | 5 |
| NestJS | 20+ MB | 20 |

Zero dependencies means core size **is** deployment size. No `node_modules` bloat.

---

## 4. CO2 / Carbonah

Estimated emissions per HTTP benchmark run (5000 requests on Apple Silicon, 15W TDP).

| Framework | JSON req/s | Est. Energy (kWh) | Est. CO2 (g) |
|-----------|:---------:|:-----------------:|:------------:|
| raw http | 85,094 | 0.0000024 | 0.0012 |
| Fastify | 55,361 | 0.0000038 | 0.0018 |
| **Tina4** | 51,111 | 0.0000041 | 0.0019 |
| Koa | 48,529 | 0.0000043 | 0.0020 |
| Express | 43,343 | 0.0000048 | 0.0023 |

*CO2 calculated at world average 475g CO2/kWh. Lower req/s = longer to serve 5000 requests = more energy.*

### Tina4 Test Suite Emissions

| Metric | Value |
|--------|-------|
| Test Execution Time | 18.00s |
| Tests | 1,669 |
| CO2 per Run | 0.038g |
| Tests per Second | 89.5 |
| Annual CI (10 runs/day) | 0.139g CO2/year |

**Carbonah Rating: A+**

---

## 5. How to Run

Benchmarks are maintained in the `tina4-python` repository's `benchmarks/` folder.

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

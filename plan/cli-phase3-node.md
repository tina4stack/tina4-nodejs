# Task: Self-describing CLI Phase 3 — Node.js mirror (queue + build)

Mirror the Python master (tina4_python/cli/__init__.py @ origin/v3) EXTERNALLY-visible
behaviour idiomatically in TypeScript. Branch: feature/cli-phase3-node (off origin/v3).

## Scope
- [x] Read Python master contract (_queue, _queue_work/stats/retry/clear, _build,
      _resolve_queue_handler, _gen_queue, COMMANDS/manifest) + its tests
      (test_cli_queue.py, test_cli_build.py, test_cli_commands_manifest.py)
- [x] Verify Node Queue/Job/LiteBackend/service-discover APIs against source
- [ ] packages/cli/src/commands/queue.ts — queueCommand + work/stats/retry/clear
      + resolveQueueHandler (real Queue, real ack/fail, --once drain, no-handler warn)
- [ ] packages/cli/src/commands/build.ts — real `docker build -t <tag> -f <file> .`,
      fail-loud guards (no Dockerfile / no docker on PATH), run hint (port 7148)
- [ ] Extend generate queue scaffold: add topic + per-job handle to default export
- [ ] Register queue (subcommands) + build in bin.ts COMMANDS registry -> manifest
- [ ] Update commandsManifest.test.ts: queue/build now ARE top-level (mirror Python)
- [ ] test/cliQueue.test.ts — real file-backed Queue, no mocks (mirror test_cli_queue.py)
- [ ] test/cliBuild.test.ts — real fail-loud guards + real docker build if present
- [ ] Full `npm test` + `npm run typecheck` green (independently re-run)

## Parity (external behaviour)
| Feature                         | Python | Node |
|---------------------------------|--------|------|
| queue work/stats/retry/clear    | done   | BUILD |
| build (docker image)            | done   | BUILD |
| generate queue topic+handle     | done   | BUILD |
| commands --json surfaces both   | done   | BUILD |

## Notes / decisions
- Node job payload is job.payload (Python job.data) — handler receives job.payload.
- --poll N is SECONDS (Python parity); Node consume() takes ms -> multiply by 1000.
- Queue default maxRetries=3, retryBackoff=0 -> a --once drain reprocesses a nacked
  job until it dead-letters within the single pass (same as Python). Bounded (no hang).
- build run-hint port = 7148 (Node Dockerfile EXPOSE 7148); Python uses 7146 — the
  dev port legitimately differs per framework.
- whichDocker: manual PATH scan (zero-dep) so an empty PATH really yields null.

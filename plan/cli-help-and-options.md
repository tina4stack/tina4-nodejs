# Task: CLI `--help` and option checking, all four frameworks (Node port)

## Outcome
`--help` / `-h` on any framework CLI command prints that command's usage and
writes nothing. Unknown options are refused with a did-you-mean, value options
need a value, and `ai --all` works. Same behaviour and same wording in Python,
PHP, Ruby and Node, each with equivalent no-mock tests.

Reference: tina4-python `9032149b` (branch `fix/cli-help-flags`). This file is
the Node port, on `fix/cli-help-flags` off `origin/v3`.

## Context
Found through `tina4 generate model --help`, which created a model called
`--help` (four files). The Rust `tina4` client forwards these commands verbatim,
so the fix belongs in the framework CLIs. On unfixed Node v3, every one of the
31 command/generator help cases ignored `--help` / `-h`, and 39 of the 62 runs
wrote to the project:

| Command with `--help` / `-h` | What it did (Node v3) |
|---|---|
| `generate <every generator>` | files named `--help` / `-h` (`generate auth` ran fully) |
| `init` | scaffolded a project called `--help` |
| `migrate:create -h` | a migration named `-h` |
| `migrate:status`, `migrate:rollback` | wrote to the project |
| `lint` | wrote to the project |
| `ai` | took `--help` as the project root |
| `queue`, `test`, `serve`, ... | ran the command, no usage |

Other broken switches found by the same audit:
- Misspelled or short options (`--feilds`, `--publc`, `-f`) were silently
  dropped: the model came out without its fields, exit 0.
- `--fields` with no value became the value `true`; `--every` with no value
  was ignored.
- `ai --all` installed into a folder named `--all` (the handler took
  `args[0]` as the project root).
- `migrate:create <desc> --fields name:string` folded `name:string` into the
  description (only `--flags` were forwarded, not their values).
- `--name=value` was parsed as an option called `name=value`.

## Design (Python is the reference)
- `CommandSpec.flags` / `GeneratorSpec.flags`: `{name: takesValue}`. Queue
  subcommands have their own map (`QUEUE_FLAGS`, queue.ts); `migrate:create`
  owns `MIGRATE_CREATE_FLAGS` (migrateCreate.ts) because it forwards them.
- `RESOLUTION_FLAGS` (`--json`, `--dry-run`) apply to EVERY Node generator:
  Node routes every write through the shared `ensureDir`/`writeFileSafe`, so
  the envelope and the dry-run work for all of them (Python: 5 targets only).
- `main()`, before any handler runs:
  1. `--help` / `-h` anywhere after a command (not `help`, not delegated) →
     that command's usage, exit 0.
  2. Unknown option → `Unknown option --feilds for "generate model". Did you mean --fields?`
     then `Run "tina4nodejs generate model --help" for its options.`, exit 1.
     Suggestion = closest accepted option by optimal-string-alignment distance,
     only when the distance is at most `max(1, floor(len/3))`.
  3. Value option with no value → `Option --fields for "generate model" needs a value: --fields <value>`, exit 1.
  4. Unknown generator / queue subcommand: not checked; its handler reports it.
- `parseFlags` (util.ts) accepts `--name=value` as well as `--name value`.
- `generate` refuses a name starting with `-` (not for `auth`, which takes none).
- Delegated commands (`doctor`, `setup`, `deploy`) are untouched.
- The top-level help no longer lists `--force` for `ai` (it was never read).

## Flags per command (what each Node handler actually reads)
| Command | Node flags | Python flags | Why different |
|---|---|---|---|
| init | — | ai, production | Node `init` reads only `[dir]` |
| serve | port=, no-browser, no-reload, no-kill, production | + host=, managed; also `start` alias | Node serve has no `--host`/`start`; `--production` is not read but the scaffolded Dockerfile passes it |
| migrate, migrate:status, migrate:rollback, seed, routes, console | — | — | |
| help | null (not checked) | None (not checked) | |
| migrate:create | fields=, table-name=, json, dry-run | same | |
| test | — (checked) | None (unchecked, pytest) | Node `test` takes one `[file]` and forwards nothing to a runner |
| lint | fix, no-install | same | |
| build | tag=, file= | same | |
| ai | all | all | |
| commands | json | json | |
| queue work / stats / retry / clear | once, poll=, services= / json / — / — | same | |

| Generator | Node flags (+ json, dry-run on all) | Python flags | Why different |
|---|---|---|---|
| model | fields=, table-name=, no-migration | same | |
| route | model=, public, table-name= | model=, public | Node resolves `--table-name` when `--model` is given |
| crud | fields=, table-name=, public, no-templates, no-migration, skip-model | same | |
| migration | fields=, table-name=, no-test | fields= | Node's `resolveTable` honours `--table-name`; `--no-test` is read |
| test | model=, public, secure-writes | model=, public | `--secure-writes` is read (crud's gate test path) |
| form, view | fields=, table-name= | same | |
| auth | — | fields=, table-name=, no-migration | Node `generateAuth` ignores its flags |
| service | every=, cron= | same | |
| seeder | table-name= | same | |
| middleware, queue, validator, websocket, listener | — | — | |
| base, page | (no such generator in Node) | — | |

## Parity
| Surface | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| `--help` / `-h` per command, no side effects | ✅ | ❌ BUILD | ❌ BUILD | ✅ |
| unknown option refused + did-you-mean | ✅ | ❌ BUILD | ❌ BUILD | ✅ |
| value option needs a value | ✅ | ❌ BUILD | ❌ BUILD | ✅ |
| `--name=value` | ✅ | ❌ BUILD | ❌ BUILD | ✅ |
| `ai --all` | ✅ | ❌ BUILD | ❌ BUILD | ✅ |
| generate name can't start with `-` | ✅ | ❌ BUILD | ❌ BUILD | ✅ |

## Tests — test/cliHelpFlags.test.ts (real, no mocks, positive + negative)
Builds the CLI (`npm run build -w packages/cli`), then runs the REAL
`node packages/cli/dist/bin.js` in temp projects with a temp HOME and a PATH
holding only node. 90 cases, 214 assertions.
- [x] every command (16, not `help`) and generator (15), `--help` and `-h`:
      exit 0, usage printed, project tree hashed before/after and unchanged (62 cases)
- [x] `--help` after the name and options still wins (2)
- [x] top-level `--help` / `-h`; `generate --help` lists every generator (3)
- [x] `help`, `help --help`, `help -h`: exit 0, full reference, never "Unknown option" (3)
- [x] a name that looks like an option is refused, nothing written (2)
- [x] misspelled options refused with the right suggestion, incl. `--feilds=x`, nothing written (5)
- [x] short and foreign options refused, no suggestion (`-f`, `lint --everything`, `migrate --force`, `test --verbose`) (4)
- [x] value option without a value refused, no stack trace (3)
- [x] `--fields price:float` and `--fields=price:float` both reach the model (2)
- [x] `migrate:create create_items --fields price:float` reaches the migration (1)
- [x] `generate crud Product --skip-model` after `generate model`: exit 0, no "already exists", model byte-identical, admin route + crud templates written (1)
- [x] `ai --all` writes CLAUDE.md into the project without the menu, no `--all` folder (1)
- [x] every option in a usage string is an accepted option; QUEUE_FLAGS covers every queue subcommand (drift guard) (1)
- [x] on unfixed v3 (source stashed, same cases): 76 passed, 137 failed — every
      one of the 62 help cases fails (no usage; 39 also wrote to the project);
      only the two top-level help cases and `--fields price:float` passed there
- [x] CLI-related test files (29): all green except versionContract (4, below)
- [x] full `npm test` (local Mac, no service containers) — see Results

## Results
| Run | Result |
|---|---|
| test/cliHelpFlags.test.ts, fixed | 214 passed, 0 failed (90 cases) |
| same cases, source at v3 | 76 passed, 137 failed (the 3 `help` cases pass there too) |
| 29 CLI-related test files | all green (versionContract 4 fail standalone: needs `TINA4_ALLOW_PRIVATE_REQUESTS`, which run-all sets; green under run-all and alone with it set) |
| `npm run typecheck` | clean |
| full `npm test`, fixed | 9914 passed, 32 failed, 288 skipped, 426 files; 15 files failed |

The 15 failing files are all live-service gates with nothing listening locally
(MongoDB, Redis/Valkey, Memcached, GreenMail, the native `tina4` binary):
messengerGreenMail, metricsHandoff, mongosqlFailClosed, queueClose,
queueDelayInvariant, queueFailureLifecycle, queueMongoRetryAndPurge,
queuePriorityInvariant, queueReachesBackend, queueSurfaceInvariant,
sessionExpiryContract, sessionHandlers, sessionMemcached,
sessionMongoRawProtocol, syncSocketTransport. Re-run one by one with the
source stashed (clean v3): identical output. Not caused by this change; needs
the lab / CI services for a full green.

## Commits
- fix(cli): --help prints usage; unknown options are refused (this commit, on fix/cli-help-flags; a commit cannot record its own hash, see `git log`)

## Status: Python done; Node done on fix/cli-help-flags (not pushed); PHP, Ruby in progress

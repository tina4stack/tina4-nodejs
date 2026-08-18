# `tina4 routes` safe discovery — 3.13.105

## Contract

`tina4 routes` is a read-only inspection command. It discovers canonical route
files, prints the registered method/path/summary data, and exits zero. It must
not execute the project's server entrypoint, open a browser, bind or take over a
port, or remain running.

## Implementation

- Lock the already-safe Node.js discovery path with a real child CLI test and an
  `app.ts` that must not run.
- Keep `src/routes` discovery and existing output stable.
- Run the targeted regression and the complete suite on the lab host as root.

## Verification

- Targeted route contract: 3 passed, 0 failed.
- Full suite: 8,256 passed, 0 failed, 61 service skips; final i18n gate 44 passed.

## Parity

The same observable contract is locked in Python, PHP, and Ruby. Language
internals may differ; all four commands must remain finite and network-free.

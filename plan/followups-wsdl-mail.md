# Task: follow-ups - WSDL parity (item 7) + mail encryption ADR-0071 (item 8)

**Outcome:** Node's SOAP handler answers the parity payloads exactly as the Python reference
(`tina4_python/wsdl/__init__.py` `_process_soap`) does, and Node's Messenger obeys ADR-0071 sections
1-3 (one SMTP transport table, unknown encryption refused, certificates always verified,
`TINA4_MAIL_TLS_INSECURE` withdrawn).

## Scope
- [x] Item 7a - an operation with a single parameter receives its value (was always null)
- [x] Item 7b - text is entity-decoded: `&amp; &lt; &gt; &quot; &apos;`, `&#65;`, `&#x42;`, CDATA
- [x] Item 7c - malformed XML answers the `Malformed XML` Client fault (was `Missing SOAP Body`,
      and the operation still ran with null)
- [x] Item 7d - a body that is not UTF-8, starts with a byte-order mark, carries a NUL / other
      non-XML character, or declares an encoding other than UTF-8 is refused with `Malformed XML`
      before any parse; DOCTYPE keeps its own refusal
- [x] Item 7e - the ten shared payloads (+ rows 11 UTF-7 DOCTYPE, 12 UTF-16LE no BOM) committed as
      a Node test
- [x] Item 8.1 - SMTP transport table: 465 always implicit TLS; `ssl` implicit TLS on any port;
      `tls`/`starttls` STARTTLS REQUIRED (fail before AUTH / MAIL FROM); `none` never upgrades
- [x] Item 8.2 - unknown SMTP and IMAP encryption raise at construction with the exact messages
- [x] Item 8.3 - certificates always verified (SMTP send, testConnection, IMAPS, IMAP STARTTLS);
      `TINA4_MAIL_TLS_INSECURE` withdrawn; private CA through `NODE_EXTRA_CA_CERTS`
- [x] Item 8.4 - IMAP `starttls` really upgrades (it logged in over plaintext)
- [x] Docs swept: example/.env.example, .claude/commands/tina4-messenger.md, tina4-wsdl.md;
      no README / CLAUDE.md / skill mentioned the old semantics or the insecure flag
- [x] CI: test/mail-infra.sh + a workflow step so the mail TLS test never skips green

## Parity
| Behaviour | Python (v3) | Node before | Node after |
|-----------|-------------|-------------|------------|
| SOAP single param | value | null | ✅ value |
| SOAP entities / CDATA | decoded | raw / null | ✅ decoded |
| SOAP malformed | Malformed XML | result null (op ran) | ✅ Malformed XML |
| SOAP empty Body | Empty SOAP Body | Missing SOAP Body | ✅ Empty SOAP Body |
| SOAP UTF-16 + BOM | Malformed XML | Missing SOAP Body | ✅ Malformed XML |
| SOAP UTF-16LE no BOM (row 12) | **EXPANDED** (reported to coordinator) | Missing SOAP Body | ✅ Malformed XML |
| SOAP non-UTF-8 declaration | accepted (being changed) | accepted | ✅ Malformed XML |
| `@WSDLOperation` standard decorator | n/a | crashed | ✅ works (both flavours) |
| mail `ssl` on non-465 | cleartext (being fixed) | cleartext | ✅ implicit TLS |
| mail STARTTLS not offered | error | cleartext | ✅ error before AUTH |
| mail unknown value | cleartext (being fixed) | cleartext | ✅ raises |
| mail cert opt-out | none | `TINA4_MAIL_TLS_INSECURE` | ✅ none |
| IMAP `starttls` | STARTTLS | plaintext LOGIN | ✅ STARTTLS, verified |
| SMTP socket timeout | 30 s / 10 s | none (hang) | ✅ 30 s / 10 s |

## Tests (written first, real - no mocks, positive + negative)
- [x] test/soapParityCorpus.test.ts - 12 payloads as bytes and as the decoded string + refusals +
      decorator + empty / non-XML bodies (93 assertions). Red on v3; mutation-proved (9 mutations, each red)
- [x] test/mailTransportTls.test.ts - pure table/refusals + lab TLS mail servers (GreenMail /
      Mailpit / Dovecot), child processes with and without `NODE_EXTRA_CA_CERTS` (59 assertions).
      Red on v3 (41 failed); mutation-proved (7 mutations, each red)

## Bugs
- [x] IMAP `starttls` mode connected in plaintext and sent LOGIN in clear  (0ffbcae)
- [x] SMTP had no socket timeout: plaintext client on a TLS port hung forever  (0ffbcae)
- [x] `@WSDLOperation` crashed under standard decorators  (9e2876b)
- [x] WSDL empty Body answered "Missing SOAP Body"  (8ef9279)
- [x] .claude/commands/tina4-wsdl.md + tina4-messenger.md documented APIs that do not exist
- [x] An empty POST body answered "Empty request body" (400), not the Client "Malformed XML" fault  (d2f8d77)
- [ ] Python reference expands row 12 (UTF-16LE no BOM) - reported to the coordinator (Python worker)
- [ ] Skill drift, not fixed here (mirrored skills): tina4-developer-nodejs auth-and-services.md says
      send() returns `{ success, error }`; it returns `{ success, message, id }`

## Commits
(rebased with --signoff onto origin/v3 1ed7b23)
- 8ef9279  fix(wsdl): SOAP handler answers the parity corpus as Python does
- 9e2876b  fix(wsdl): refuse a non-UTF-8 XML declaration; @WSDLOperation works as a standard decorator
- 0ffbcae  fix(messenger): mail encryption means what it says (ADR-0071)
- b5c78a0  test(messenger): pin an explicitly empty TINA4_MAIL_ENCRYPTION / IMAP value raising
- d2f8d77  fix(wsdl): an empty POST body is the Client "Malformed XML" fault

## Status: In Progress (lab full suite at HEAD pending)

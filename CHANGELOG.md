# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Test suite** — 316 tests across 11 files, run with `npm test`. It is built around the behaviours that would fail
  _silently_ if a refactor undid them: the call would still succeed, still return a plausible envelope, and still do
  the wrong thing. Every one of them was a real bug during development.
  - **Tool layer** drives a real `McpServer` over an in-memory transport with a stubbed WeFact client, so the MCP
    SDK's server-side zod validation runs for real — which matters, because the `CostCategory` coercion lives
    entirely in a `.transform` a capture-fake would never execute.
  - **Write and send gates** are swept across all 28 write tools: blocked without `WEFACT_ALLOW_WRITES`, dry-run
    without `confirm`, and — for the four tools that email customers — still blocked with `WEFACT_ALLOW_SEND` unset
    _even when `confirm: true` is passed_. Each case also asserts the client was never called.
  - **Line routing** locks the trap the WeFact docs get wrong: `sortlines` on the parent controller, line
    `add`/`delete` on the line controller, plus static invariants over the whole endpoint map.
  - **Client layer** runs real axios against `nock`, so the axios configuration is the subject rather than a mock:
    a 403 firewall ban is never retried, transient failures back off 1s then 4s, the rate-limit throttle waits out
    the minute window, and `paginate` returns `[]` when WeFact omits the rows key.
  - **Schema shape snapshot** of all 51 tools, excluding descriptions, so a change to the contract agents depend on
    cannot pass unnoticed while prose edits stay noise-free.
  - Each locked behaviour was verified by breaking it and confirming the corresponding test fails.
- **Contract tests** (`npm run test:contract`) — four live calls confirming the endpoint map still holds. Opt-in,
  and they refuse to run under `CI`/`GITHUB_ACTIONS`: a runner's egress IP cannot be whitelisted, so an attempt
  there would fail _and_ consume the per-IP daily failed-authentication cap. The full 97-endpoint sweep sits behind
  a second flag.
- **CI workflow** on pull requests and pushes to main: typecheck, format check, build, tests, coverage, and an
  `npm pack` assertion that no test file reaches the published tarball. Node 20/22/24, actions pinned to SHAs.
  `publish.yml` now runs the typecheck and tests before building.
- `npm run typecheck` covers `src`, `test` **and `scripts`** — the last of which the build config never reached, so
  the two probe scripts were shipping unchecked.

### Changed

- Tool registration moved from `src/index.ts` into `src/register-tools.ts`, so the suite drives the real tool set
  rather than a hand-maintained copy. `TOOL_COUNT` feeds the startup banner and is asserted against the registered
  set, so the banner cannot drift.
- `offset` and `limit` are gone from the auto-paginated list tools. `paginate()` sets both itself and silently
  overwrote anything a caller passed, while the schema advertised `offset` as "Row offset for manual paging" —
  a promise the code never kept. `list_groups`, which calls the API directly and genuinely honours them, keeps both.

### Fixed

- `save_subscription` no longer sends `Identifier` when creating a subscription. WeFact rejects it
  ("Een Identifier is niet toegestaan voor deze actie"); the guard was applied to the other create tools but missed
  here, and the live probe never caught it because subscription validation fails on other fields first.

### Security

- The API client now refuses any request whose `params` carry `api_key`, `controller` or `action`, and builds the
  request body so those reserved keys are set last. Tool arguments could not reach them before either — the MCP SDK
  strips unknown top-level keys during zod parsing — but the guarantee now lives in the client, so a future tool that
  spreads a caller-controlled record into `params` fails loudly instead of authenticating as a different account or
  reaching an endpoint that never passed the write/send gate.
- The publish workflow pins both GitHub Actions to commit SHAs instead of movable tags, declares least-privilege
  `permissions`, publishes with `--provenance`, and refuses to publish when the pushed tag disagrees with the version
  in `package.json`.

## [1.0.0] - 2026-07-25

First release: complete coverage of the WeFact API v2 across all 17 controllers, in 51 tools.

### Added

- **Connection tools.** `whoami` runs the parameterless `settings/list` probe and reports corporate identities, the
  sale and purchase VAT code tables, rate-limit headroom, configured administrations and which write gates are
  enabled. `reload_credentials` swaps in a new credentials file without restarting the server.
- **Customers and suppliers.** `list_debtors`, `get_debtor`, `save_debtor`, `manage_debtor_contacts`,
  `list_creditors`, `get_creditor`, `save_creditor`.
- **Products and groups.** `list_products`, `get_product`, `save_product`, `list_groups`, `manage_group`.
- **Invoices.** `list_invoices`, `get_invoice`, `save_invoice`, `manage_invoice_lines`, `register_payment`,
  `credit_invoice`, `set_invoice_state`.
- **Price quotes.** `list_price_quotes`, `get_price_quote`, `save_price_quote`, `manage_price_quote_lines`,
  `set_price_quote_status`.
- **Purchase invoices.** `list_credit_invoices`, `get_credit_invoice`, `save_credit_invoice`,
  `manage_credit_invoice_lines`.
- **Subscriptions.** `list_subscriptions`, `get_subscription`, `save_subscription`, `terminate_subscription`.
- **Bank transactions.** `list_transactions`, `get_transaction`, `create_transaction`, `match_transaction`,
  `ignore_transaction`.
- **CRM.** `list_crm_records`, `get_crm_record`, `save_crm_record`.
- **Documents and files.** `download_document`, `schedule_document_send`, `manage_attachments`, `delete_record`.
- **Settings.** `get_settings`, `manage_cost_category`.
- **Write gate.** No tool writes anything unless `WEFACT_ALLOW_WRITES=true`, and every write returns a dry-run
  preview of the exact request body until called with `confirm: true`. Irreversible operations add a plain-English
  `consequence` line to that preview.
- **Send gate.** `send_invoice_by_email`, `send_invoice_reminder`, `send_price_quote_by_email` and
  `schedule_document_send` additionally require `WEFACT_ALLOW_SEND=true`, so enabling ordinary writes never implies
  permission to email customers. `match_transaction` enforces the same gate when a reversal would notify the client.
- **Rate-limit protection.** The `API-RateLimit-*` headers are parsed from every response and the client pauses
  before the per-IP minute window runs dry (`WEFACT_RATE_LIMIT_RESERVE`). Transient failures retry twice with
  jittered backoff; firewall bans and authentication failures are never retried, since WeFact answers a breach with
  an IP block and caps failed authentication attempts separately.
- **Error classification.** WeFact returns HTTP 200 with Dutch prose for every failure, so errors are classified
  into `ip-not-whitelisted`, `firewalled`, `auth`, `invalid-endpoint`, `api`, `http` and `network`, with a
  remediation hint attached to the operator-fixable ones.
- **Multi-administration support.** `~/.wefact/credentials.json` maps labels to API keys, with a `WEFACT_API_KEY`
  environment fallback and an optional `administration` argument on every tool.
- **Pagination driven by `totalresults`**, returning `count`, `totalResults` and `truncated` so an agent can tell a
  complete result from a clipped one. Empty lists are handled explicitly, since WeFact omits the rows key entirely
  rather than returning an empty array.
- **Output annotation.** Coded fields (invoice status, quote status, purchase-invoice status, period, invoice
  method, payment method, transaction status) are returned with a readable `…Label` alongside the raw code.
- `scripts/whoami.ts` and `scripts/probe-endpoints.ts`, the latter re-validating every controller/action pair
  against the live API.

### Fixed

Behaviours where the published WeFact documentation is wrong, verified against a live administration:

- **`sortlines` is on the parent controller**, not the line controller — `invoice/sortlines` and
  `pricequote/sortlines` work, while `invoiceline/sortlines` and `pricequoteline/sortlines` return "Invalid action".
  Line `add` and `delete` really are on the line controller, so the two halves of `manage_invoice_lines` and
  `manage_price_quote_lines` route to different controllers.
- **Actions that do not exist** despite being documented or implied: `invoice/payment`, `transaction/edit`,
  `creditinvoice/download`, `creditinvoice/sendbyemail`, `debtor/delete`. Tools are shaped around their absence
  rather than failing at runtime.
- **`add` actions reject a stray `Identifier`** ("Een Identifier is niet toegestaan voor deze actie"), so it is
  never sent on create.
- **`CostCategory` on purchase invoice lines must be a string**, not the int the documentation specifies — a JSON
  number is rejected with "Invalid type for 'InvoiceLines[0].CostCategory'". The schema accepts either and coerces.
- **Bank transaction amounts carry direction in their sign**: `withdrawal` and `reversal` require a negative
  `amount`. `create_transaction` validates this up front rather than letting the call fail.
- **`extraclientcontact/edit` re-validates the identifying trio**, so a partial update still has to resend one of
  `CompanyName`, `LastName` or `EmailAddress`. `manage_debtor_contacts` says so explicitly instead of surfacing
  WeFact's ambiguous Dutch error.
- **Invoice status 9 ("vervallen") means voided _or_ expired** — crediting a paid invoice moves the original to 9,
  so the label reads "voided or expired" rather than committing to the wrong half.
- **Rate limits are ~500/minute and ~5000/hour**, not the 200/3600 the documentation states.

[Unreleased]: https://github.com/CodeMill-Solutions/wefact-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CodeMill-Solutions/wefact-mcp/releases/tag/v1.0.0

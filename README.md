# WeFact MCP server

[![npm](https://img.shields.io/npm/v/@codemill-solutions/wefact-mcp)](https://www.npmjs.com/package/@codemill-solutions/wefact-mcp)

An [MCP](https://modelcontextprotocol.io) server for the [WeFact](https://www.wefact.nl) API v2, giving an AI agent
access to your invoicing administration: customers and suppliers, products, invoices, subscriptions, price quotes,
purchase invoices, bank transactions and CRM. It covers all 17 WeFact controllers through 51 tools.

> **Read-only by default.** Writing anything requires `WEFACT_ALLOW_WRITES=true`, and every write stays a dry-run
> until it is called with `confirm: true`. The four tools that email your customers need a second opt-in,
> `WEFACT_ALLOW_SEND=true`, so enabling writes never implies permission to contact customers.

---

## How it works

1. WeFact exposes a single endpoint, `https://api.mijnwefact.nl/v2/`. Every call is a POST whose body carries an
   `api_key`, a `controller` and an `action`.
2. One API key belongs to exactly one administration. There is no session or token exchange — the key authenticates
   each call directly.
3. WeFact answers with HTTP 200 even for failures, so success is read from the body's `status` field. This server
   translates failures into descriptive errors that name the operation and, where you can act on it, what to do.

---

## Installation

```bash
npm install -g @codemill-solutions/wefact-mcp
```

Or run it straight from npm without installing:

```bash
npx @codemill-solutions/wefact-mcp
```

Or from a clone:

```bash
git clone https://github.com/CodeMill-Solutions/wefact-mcp.git
cd wefact-mcp
npm install
npm run build
```

### Requirements

- Node.js 20 or newer
- A WeFact administration with the API enabled

---

## Setup

### 1. Enable the API and whitelist your IP

**This is the step people miss.** In WeFact, go to **Instellingen → API**. There you can switch the API on, create an
API key, and — crucially — add IP addresses to the whitelist. Calls from any other address fail with:

```
IP 203.0.113.9 has no access to API
```

To find the address that needs whitelisting, run `npm run whoami`: it prints your machine's public IP before it does
anything else. If the server runs somewhere with a changing IP, whitelist the whole range or use a fixed egress.

The same settings page keeps a request log, which is useful when a call behaves unexpectedly.

### 2. Configure credentials

**Single administration (env vars)**

```dotenv
WEFACT_API_KEY=your-secret-api-key
WEFACT_ADMINISTRATION=demo
```

`WEFACT_ADMINISTRATION` is just a local label. When omitted, the key is registered under `default`.

**Multiple administrations (credentials file)**

```json
{
  "acme": { "api_key": "..." },
  "widgets-bv": { "api_key": "..." }
}
```

Save it as `~/.wefact/credentials.json`. The path is resolved as `WEFACT_CREDENTIALS_FILE` →
`~/.wefact/credentials.json` → `./credentials.json`, and both `api_key` and `apiKey` are accepted as the field name.

### 3. Verify the connection

```bash
npm run whoami
```

This prints your public IP, the administrations it found, the corporate identities and VAT codes your write tools
will need, and the current API rate-limit headroom. It names the three common failure modes distinctly, so you can
tell a rejected key from a non-whitelisted IP from a rate-limit ban.

To re-validate every controller/action pair against the live API:

```bash
npm run probe
```

### 4. Connect from an MCP client

```json
{
  "mcpServers": {
    "wefact": {
      "command": "npx",
      "args": ["-y", "@codemill-solutions/wefact-mcp"],
      "env": {
        "WEFACT_API_KEY": "your-secret-api-key",
        "WEFACT_ADMINISTRATION": "demo"
      }
    }
  }
}
```

From a clone, point at the built entry point instead:

```json
{
  "mcpServers": {
    "wefact": {
      "command": "node",
      "args": ["/absolute/path/to/wefact-mcp/dist/index.js"],
      "env": {
        "WEFACT_API_KEY": "your-secret-api-key"
      }
    }
  }
}
```

---

## Multi-administration support

- Every tool accepts an optional `administration` argument selecting which key to use.
- Without it, the default is `WEFACT_ADMINISTRATION`, or the first entry in the credentials file.
- `reload_credentials` picks up changes to the file without restarting the server.
- Rate limits are per IP, not per key, so several administrations behind one address share one budget.

---

## Available tools (51)

All list tools are auto-paginated and return `count`, `totalResults` and `truncated`, so you can tell when a result
was cut short by `maxItems` and should be narrowed instead. Coded fields (statuses, periods, payment methods) come
back annotated with a readable `…Label`.

### Connection

| Tool                 | Description                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`             | Verify the connection and report corporate identities, VAT codes, rate-limit headroom and which gates are enabled. Start here when something fails. |
| `reload_credentials` | Reload the administration → API-key map from disk without restarting.                                                                               |

### Settings

| Tool                   | Description                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `get_settings`         | Corporate identities, sale/purchase VAT codes and VAT rules, or the cost categories that purchase-invoice lines need. |
| `manage_cost_category` | **Write.** Create, rename or remove a cost category. Deleting is a soft delete.                                       |

### Customers and suppliers

| Tool                     | Description                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `list_debtors`           | List customers, with search, group and date filters.                                     |
| `get_debtor`             | One customer in full, including invoice preferences, mandate details and extra contacts. |
| `save_debtor`            | **Write.** Create or update a customer.                                                  |
| `manage_debtor_contacts` | **Write.** Add, edit or remove an extra contact person.                                  |
| `list_creditors`         | List suppliers.                                                                          |
| `get_creditor`           | One supplier in full, including bank details and booking rules.                          |
| `save_creditor`          | **Write.** Create or update a supplier.                                                  |

> WeFact has **no delete action for customers** — they can be created and edited, never removed via the API.

### Products and groups

| Tool            | Description                                                                                |
| --------------- | ------------------------------------------------------------------------------------------ |
| `list_products` | List products, with search, group and date filters.                                        |
| `get_product`   | One product in full, including its subscription period.                                    |
| `save_product`  | **Write.** Create or update a product.                                                     |
| `list_groups`   | List customer or product groups. `type` is required.                                       |
| `manage_group`  | **Write.** Create, edit or delete a group. On edit, the member list is replaced wholesale. |

### Invoices

| Tool                    | Description                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `list_invoices`         | List invoices by status, customer and date. Overdue invoices are `status: "sent"` with a `payBeforeTo` of today. |
| `get_invoice`           | One invoice in full, including lines, payments and attachments.                                                  |
| `save_invoice`          | **Write.** Create or update an invoice. Creating always produces a draft; nothing is sent.                       |
| `manage_invoice_lines`  | **Write.** Add, delete or reorder invoice lines. Works on invoices in any status.                                |
| `register_payment`      | **Write.** Book a partial payment, or mark an invoice paid or unpaid. Also handles purchase invoices.            |
| `credit_invoice`        | **Write.** Create a credit invoice reversing a finalised one. The only way to undo a sent invoice.               |
| `set_invoice_state`     | **Write.** Block/unblock a draft, or pause/reactivate the payment and reminder process.                          |
| `send_invoice_by_email` | **Write + send.** Emails the customer, finalises the draft and assigns its permanent number.                     |
| `send_invoice_reminder` | **Write + send.** Emails a payment reminder or a formal demand.                                                  |

### Price quotes

| Tool                        | Description                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `list_price_quotes`         | List quotes by status, archive flag and date.                                             |
| `get_price_quote`           | One quote in full, including its customer-facing `AcceptURL`.                             |
| `save_price_quote`          | **Write.** Create or update a quote. Creating always produces a concept.                  |
| `manage_price_quote_lines`  | **Write.** Add, delete or reorder quote lines.                                            |
| `set_price_quote_status`    | **Write.** Accept, decline or archive a quote. Accepting can also create a draft invoice. |
| `send_price_quote_by_email` | **Write + send.** Emails the quote and publishes its online accept link.                  |

### Purchase invoices

| Tool                          | Description                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| `list_credit_invoices`        | List purchase invoices (bills received from suppliers).           |
| `get_credit_invoice`          | One purchase invoice in full, including cost categories per line. |
| `save_credit_invoice`         | **Write.** Book or update a supplier invoice.                     |
| `manage_credit_invoice_lines` | **Write.** Add or delete purchase invoice lines.                  |

> Purchase invoices use a **different status scale** from sales invoices: 1 unpaid, 2 partly paid, 3 paid, 8 credit.
> They have no quantity field on lines, and cannot be downloaded or emailed — WeFact has no such actions.

### Subscriptions

| Tool                     | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `list_subscriptions`     | List subscriptions, sorted by next billing date.                                           |
| `get_subscription`       | One subscription in full, including its recurrence and end conditions.                     |
| `save_subscription`      | **Write.** Create or update a subscription. Creating one can trigger an immediate invoice. |
| `terminate_subscription` | **Write.** Cancel a subscription, or undo a cancellation. The only way to end one.         |

### Bank transactions

| Tool                 | Description                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `list_transactions`  | List bank transactions by direction and reconciliation status.                                         |
| `get_transaction`    | One transaction in full, including what it has been matched against.                                   |
| `create_transaction` | **Write.** Import a bank transaction. There is no edit action — corrections mean delete and re-create. |
| `match_transaction`  | **Write.** Reconcile a transaction against one or more documents, optionally marking them paid.        |
| `ignore_transaction` | **Write.** Mark a transaction as ignored. There is no documented way to undo this.                     |

### CRM

| Tool               | Description                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| `list_crm_records` | List tasks, or interactions for a specific record.                            |
| `get_crm_record`   | One task or interaction in full.                                              |
| `save_crm_record`  | **Write.** Create or update a task or interaction, or change a task's status. |

> `list_crm_records` with `type: "interaction"` **requires** `referenceId` and `referenceType` — WeFact cannot list
> all interactions. Neither tasks nor interactions can be deleted.

### Documents and files

| Tool                     | Description                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `download_document`      | Download an invoice or quote as PDF or UBL, or any attachment, as base64.                           |
| `schedule_document_send` | **Write + send.** Arm an automatic send at a future moment, or cancel one.                          |
| `manage_attachments`     | **Write.** Attach a file to any record, or remove one.                                              |
| `delete_record`          | **Write.** Permanently delete a supplier, product, invoice, purchase invoice, quote or transaction. |

Write tools are gated behind `WEFACT_ALLOW_WRITES` and stay dry-run unless `confirm: true`. See
[Writing data](#writing-data).

---

## Writing data

Three guards, in order:

1. **The env gate.** Nothing is written unless `WEFACT_ALLOW_WRITES=true` is set in the server environment.
2. **The send gate.** Tools that email your customers additionally require `WEFACT_ALLOW_SEND=true`.
3. **The dry-run.** Every write tool returns a preview of the exact request body — plus a plain-English
   `consequence` for irreversible ones — until it is called with `confirm: true`.

```json
{
  "mcpServers": {
    "wefact": {
      "command": "npx",
      "args": ["-y", "@codemill-solutions/wefact-mcp"],
      "env": {
        "WEFACT_API_KEY": "your-secret-api-key",
        "WEFACT_ALLOW_WRITES": "true",
        "WEFACT_ALLOW_SEND": "true"
      }
    }
  }
}
```

> All env values must be **strings** — use `"true"`, not `true`.

### Example (dry-run)

```jsonc
{
  "action": "add",
  "DebtorCode": "DB10000", // the customer
  "InvoiceLines": [
    { "ProductCode": "P0001", "Number": 2 }, // price, VAT and description come from the product
    { "Description": "Reiskosten", "PriceExcl": 0.19, "Number": 120 },
  ],
  // no "confirm" → returns the planned invoice without creating it
}
```

### What sending really does

`send_invoice_by_email` is the sharpest edge in the API. Besides emailing the customer, it **finalises the draft**:
the placeholder `[concept]0001` is replaced by a permanent invoice number and the invoice can no longer be deleted,
only credited. There are no template or recipient parameters — delivery is driven entirely by the invoice's own
`EmailAddress`, `InvoiceMethod` and `LanguageCode`, so check them with `get_invoice` and change them with
`save_invoice` first.

`schedule_document_send` arms exactly the same thing at a future moment, which is why it sits behind the same gate.

### Safety defaults that differ from WeFact's own

Two WeFact defaults are surprising enough that this server overrides them, and says so in the tool descriptions:

- **`UseProductInventory`** defaults to `"yes"` in WeFact, so creating an invoice or quote silently decrements
  stock. `save_invoice` and `save_price_quote` default it to `"no"`; pass `"yes"` deliberately.
- **`RecalculateInclTotalAmount`** defaults to `"no"` in WeFact, leaving a purchase invoice's VAT-inclusive total
  stale after a line change. `manage_credit_invoice_lines` defaults it to `"yes"`.

### Rate limits

WeFact allows roughly 500 calls per minute and 5000 per hour **per IP**, and answers a breach by firewalling the
address rather than returning a soft 429. Failed authentication attempts count too, and have their own daily cap.

This server therefore watches the `API-RateLimit-*` headers on every response and pauses before it would run the
minute window dry (`WEFACT_RATE_LIMIT_RESERVE`, default 5 calls of headroom). Transient failures are retried twice
with backoff; rate-limit bans and authentication failures are **never** retried, because retrying makes both worse.

---

## Testing

```bash
npm run dev        # run from source with tsx
npm run whoami     # verify credentials, IP whitelisting and rate limits
npm run probe      # re-validate every controller/action pair against the live API
npm run inspect    # explore the tools with the MCP Inspector
```

---

## Architecture

```
src/
├── index.ts                 # bootstrap, tool registration, stderr banner
├── wefact-client.ts         # credentials, request, error classification, rate limiting, pagination
├── wefact-endpoints.ts      # every controller/action pair, in one place
└── tools/
    ├── result.ts            # ok() / fail() / guard() — uniform JSON tool results
    ├── write-helpers.ts     # the write gate, the send gate and the dry-run
    ├── schemas.ts           # shared zod shapes and parameter builders
    ├── enums.ts             # status maps and output annotation
    ├── <domain>.ts          # read tools
    ├── <domain>-write.ts    # write tools
    └── <domain>-send.ts     # tools that email customers, isolated on purpose
```

`wefact-endpoints.ts` exists because WeFact's controller/action strings do not always match its documentation URLs,
and the published docs are wrong in several places. Verified against the live API: `sortlines` lives on the **parent**
controller (`invoice`, `pricequote`) while line add/delete lives on the **line** controller (`invoiceline`,
`pricequoteline`); `/setting/*` is controller `settings` with underscore actions like `costcategory_list`; and
hyphenated URLs flatten into the action (`cancel-schedule` → `cancelschedule`). Keeping the map in one file means a
reviewer can diff it against the API in one place — that is what `npm run probe` does.

---

## Roadmap

- **1.0.0** — full coverage of all 17 WeFact controllers across 51 tools; write and send gates; proactive rate-limit
  throttling; multi-administration support.
- Unprocessed purchase invoices (WeFact's inbox for incoming bills) _(planned)_
- Webhook support so agents can react to payments instead of polling _(planned)_

---

## About CodeMill

This project is built and maintained by [**CodeMill
Solutions**](https://codemill.dev), a Dutch software development agency
specializing in custom web applications, API integrations, mobile apps, and AI
agents & automation for small and medium-sized businesses.

Founded by engineers with 20+ years of combined experience, CodeMill favors
short communication lines, direct client relationships, and open-source
foundations to avoid vendor lock-in. A recurring focus is connecting accounting
and ERP systems to modern AI workflows — this MCP server sits alongside sibling
projects such as
[`@codemill-solutions/yuki-mcp`](https://www.npmjs.com/package/@codemill-solutions/yuki-mcp)
and
[`@codemill-solutions/twinfield-mcp`](https://www.npmjs.com/package/@codemill-solutions/twinfield-mcp),
bringing Dutch accounting platforms within reach of AI agents.

Based in Noord-Brabant and Overijssel (Netherlands), working bilingually in
Dutch and English across the Netherlands and the broader European market.

📧 Interested in a custom integration? Reach out via [codemill.dev](https://codemill.dev).

---

## License

MIT © CodeMill Solutions B.V.

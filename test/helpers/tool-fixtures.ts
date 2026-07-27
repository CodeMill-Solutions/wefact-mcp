/**
 * Minimal valid arguments for every tool, keyed by tool name.
 *
 * This exists so the sweeps (result shape, write gate, stray-Identifier) can be
 * table-driven across the whole surface instead of hand-written 51 times. A
 * tool added without an entry here fails `registration.test.ts`, which asserts
 * this map covers exactly the registered set — so the sweeps can never silently
 * stop covering something.
 *
 * "Minimal" means: enough to pass zod validation and the handler's own guards,
 * and nothing more. Values are obviously fake so a fixture can never be
 * mistaken for real data if one ever escapes into a live call.
 */

export const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  // ── Connection ────────────────────────────────────────────────────────────
  whoami: {},
  reload_credentials: { path: '/nonexistent/credentials.json' },

  // ── Settings ──────────────────────────────────────────────────────────────
  get_settings: {},
  manage_cost_category: { action: 'add', title: 'Fixture category' },

  // ── Customers and suppliers ───────────────────────────────────────────────
  list_debtors: {},
  get_debtor: { identifier: 1 },
  save_debtor: { action: 'add', CompanyName: 'Fixture B.V.' },
  manage_debtor_contacts: { action: 'add', debtorCode: 'DB10000', LastName: 'Fixture' },
  list_creditors: {},
  get_creditor: { identifier: 1 },
  save_creditor: { action: 'add', CompanyName: 'Fixture Supplier B.V.' },

  // ── Products and groups ───────────────────────────────────────────────────
  list_products: {},
  get_product: { identifier: 1 },
  save_product: { action: 'add', ProductName: 'Fixture', ProductKeyPhrase: 'Fixture line', PriceExcl: 10 },
  list_groups: { type: 'debtor' },
  manage_group: { action: 'add', type: 'debtor', groupName: 'Fixture group' },

  // ── Invoices ──────────────────────────────────────────────────────────────
  list_invoices: {},
  get_invoice: { identifier: 1 },
  save_invoice: {
    action: 'add',
    DebtorCode: 'DB10000',
    InvoiceLines: [{ Description: 'Fixture line', PriceExcl: 10, Number: 1 }],
  },
  manage_invoice_lines: {
    action: 'add',
    identifier: 1,
    lines: [{ Description: 'Fixture line', PriceExcl: 10 }],
  },
  register_payment: { action: 'paid', identifier: 1 },
  credit_invoice: { identifier: 1 },
  set_invoice_state: { action: 'block', identifier: 1 },
  send_invoice_by_email: { identifier: 1 },
  send_invoice_reminder: { level: 'reminder', identifier: 1 },

  // ── Purchase invoices ─────────────────────────────────────────────────────
  list_credit_invoices: {},
  get_credit_invoice: { identifier: 1 },
  save_credit_invoice: {
    action: 'add',
    CreditorCode: 'CD50000',
    InvoiceCode: 'FIXTURE-001',
    InvoiceLines: [{ Description: 'Fixture line', PriceExcl: 10 }],
  },
  manage_credit_invoice_lines: {
    action: 'add',
    identifier: 1,
    lines: [{ Description: 'Fixture line', PriceExcl: 10 }],
  },

  // ── Price quotes ──────────────────────────────────────────────────────────
  list_price_quotes: {},
  get_price_quote: { identifier: 1 },
  save_price_quote: {
    action: 'add',
    DebtorCode: 'DB10000',
    PriceQuoteLines: [{ Description: 'Fixture line', PriceExcl: 10, Number: 1 }],
  },
  manage_price_quote_lines: {
    action: 'add',
    identifier: 1,
    lines: [{ Description: 'Fixture line', PriceExcl: 10 }],
  },
  set_price_quote_status: { action: 'accept', identifier: 1 },
  send_price_quote_by_email: { identifier: 1 },

  // ── Documents ─────────────────────────────────────────────────────────────
  download_document: { type: 'invoice', identifier: 1 },
  schedule_document_send: { action: 'schedule', type: 'invoice', identifier: 1, sendAt: '2099-01-01 09:00:00' },

  // ── Subscriptions ─────────────────────────────────────────────────────────
  list_subscriptions: {},
  get_subscription: { identifier: 1 },
  save_subscription: { action: 'add', DebtorCode: 'DB10000', ProductCode: 'P0001' },
  terminate_subscription: { identifier: 1, terminationDate: '2099-12-31' },

  // ── Bank transactions ─────────────────────────────────────────────────────
  list_transactions: {},
  get_transaction: { identifier: 1 },
  create_transaction: {
    bankAccount: 'NL91ABNA0417164300',
    date: '2099-01-01',
    type: 'deposit',
    amount: 100,
    currency: 'EUR',
  },
  match_transaction: {
    identifier: 1,
    matches: [
      { ReferenceId: 1, ReferenceType: 'invoice', MatchedAmount: 100, Currency: 'EUR', PaymentType: 'received' },
    ],
  },
  ignore_transaction: { identifier: 1 },

  // ── CRM ───────────────────────────────────────────────────────────────────
  list_crm_records: { type: 'task' },
  get_crm_record: { type: 'task', identifier: 1 },
  save_crm_record: { type: 'task', action: 'add', title: 'Fixture task' },

  // ── Attachments and deletion ──────────────────────────────────────────────
  manage_attachments: {
    action: 'add',
    type: 'invoice',
    identifier: 1,
    filename: 'fixture.pdf',
    base64: 'Zml4dHVyZQ==',
  },
  delete_record: { type: 'invoice', identifier: 1 },
};

/**
 * Tools that reach outside the system by emailing a customer. These need
 * `WEFACT_ALLOW_SEND` on top of `WEFACT_ALLOW_WRITES`.
 */
export const SEND_TOOLS = [
  'send_invoice_by_email',
  'send_invoice_reminder',
  'send_price_quote_by_email',
  'schedule_document_send',
] as const;

/** Tools that perform no write and therefore have no gate. */
export const READ_TOOLS = [
  'whoami',
  'reload_credentials',
  'get_settings',
  'list_debtors',
  'get_debtor',
  'list_creditors',
  'get_creditor',
  'list_products',
  'get_product',
  'list_groups',
  'list_invoices',
  'get_invoice',
  'list_credit_invoices',
  'get_credit_invoice',
  'list_price_quotes',
  'get_price_quote',
  'list_subscriptions',
  'get_subscription',
  'list_transactions',
  'get_transaction',
  'list_crm_records',
  'get_crm_record',
  'download_document',
] as const;

/** Every tool that goes through the write gate. */
export function writeToolNames(): string[] {
  const read = new Set<string>(READ_TOOLS);
  return Object.keys(TOOL_ARGS)
    .filter((name) => !read.has(name))
    .sort();
}

export function argsFor(name: string): Record<string, unknown> {
  const args = TOOL_ARGS[name];
  if (!args) throw new Error(`No fixture arguments for tool "${name}" — add one to test/helpers/tool-fixtures.ts`);
  return structuredClone(args);
}

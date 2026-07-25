/**
 * Every WeFact controller/action pair used by this server, in one place.
 *
 * WeFact routes on a `controller` + `action` pair sent in the request body, and
 * those strings do **not** always match the documentation's URL paths. Several
 * mappings are outright wrong in the official docs; the ones marked "verified"
 * below were probed against a live account on 2026-07-25.
 *
 * Keeping them here means each trap is encoded once and a reviewer can diff a
 * single file against the API instead of grepping 25 tool modules.
 *
 * The traps, for the record:
 *   - `sortlines` lives on the PARENT controller (`invoice`, `pricequote`),
 *     while `add`/`delete` for the same lines live on the LINE controller
 *     (`invoiceline`, `pricequoteline`). The docs put both on the line
 *     controller; that is wrong and yields "Invalid action".
 *   - `/setting/*` is controller `settings` (plural), and its sub-resources are
 *     underscore-joined actions (`costcategory_list`), not a nested controller.
 *   - Hyphenated URL segments are flattened into the action: `cancel-schedule`
 *     → `cancelschedule`, `payment-process/pause` → `paymentprocesspause`.
 *   - Attachments for every parent type share one `attachment` controller,
 *     discriminated by a `Type` parameter.
 */

export interface Endpoint {
  controller: string;
  action: string;
}

const ep = (controller: string, action: string): Endpoint => ({ controller, action });

export const EP = {
  // ── Settings ──────────────────────────────────────────────────────────────
  /** Parameterless; the cheapest connection probe. Verified. */
  settingsList: ep('settings', 'list'),
  costCategoryList: ep('settings', 'costcategory_list'),
  costCategoryShow: ep('settings', 'costcategory_show'),
  costCategoryAdd: ep('settings', 'costcategory_add'),
  costCategoryEdit: ep('settings', 'costcategory_edit'),
  costCategoryDelete: ep('settings', 'costcategory_delete'),

  // ── Debtors (customers) ───────────────────────────────────────────────────
  // NOTE: there is no `debtor/delete` — verified, returns "Invalid action".
  debtorList: ep('debtor', 'list'),
  debtorShow: ep('debtor', 'show'),
  debtorAdd: ep('debtor', 'add'),
  debtorEdit: ep('debtor', 'edit'),

  /** Extra contact persons live on their own controller, not under `debtor`. Verified. */
  extraContactAdd: ep('extraclientcontact', 'add'),
  extraContactEdit: ep('extraclientcontact', 'edit'),
  extraContactDelete: ep('extraclientcontact', 'delete'),

  // ── Creditors (suppliers) ─────────────────────────────────────────────────
  creditorList: ep('creditor', 'list'),
  creditorShow: ep('creditor', 'show'),
  creditorAdd: ep('creditor', 'add'),
  creditorEdit: ep('creditor', 'edit'),
  creditorDelete: ep('creditor', 'delete'),

  // ── Products ──────────────────────────────────────────────────────────────
  productList: ep('product', 'list'),
  productShow: ep('product', 'show'),
  productAdd: ep('product', 'add'),
  productEdit: ep('product', 'edit'),
  productDelete: ep('product', 'delete'),

  // ── Groups (customer & product groups) ────────────────────────────────────
  /** Requires a `type` of "debtor" or "product". Verified. */
  groupList: ep('group', 'list'),
  groupShow: ep('group', 'show'),
  groupAdd: ep('group', 'add'),
  groupEdit: ep('group', 'edit'),
  groupDelete: ep('group', 'delete'),

  // ── Invoices ──────────────────────────────────────────────────────────────
  invoiceList: ep('invoice', 'list'),
  invoiceShow: ep('invoice', 'show'),
  invoiceAdd: ep('invoice', 'add'),
  invoiceEdit: ep('invoice', 'edit'),
  /** Drafts only; finalised invoices must be credited instead. */
  invoiceDelete: ep('invoice', 'delete'),
  invoiceCredit: ep('invoice', 'credit'),
  invoicePartPayment: ep('invoice', 'partpayment'),
  invoiceMarkAsPaid: ep('invoice', 'markaspaid'),
  invoiceMarkAsUnpaid: ep('invoice', 'markasunpaid'),
  invoiceDownload: ep('invoice', 'download'),
  invoiceBlock: ep('invoice', 'block'),
  invoiceUnblock: ep('invoice', 'unblock'),
  invoiceSchedule: ep('invoice', 'schedule'),
  /** URL is /invoice/cancel-schedule; the action has no hyphen. Verified. */
  invoiceCancelSchedule: ep('invoice', 'cancelschedule'),
  /** URL is /invoice/payment-process/pause. Verified. */
  invoicePausePayment: ep('invoice', 'paymentprocesspause'),
  invoiceReactivatePayment: ep('invoice', 'paymentprocessreactivate'),
  /** THESE EMAIL THE CUSTOMER. sendbyemail also finalises the draft and numbers it. */
  invoiceSendByEmail: ep('invoice', 'sendbyemail'),
  invoiceSendReminder: ep('invoice', 'sendreminderbyemail'),
  invoiceSendSummation: ep('invoice', 'sendsummationbyemail'),

  /** Sorting is on the PARENT controller — the docs say `invoiceline`, which fails. Verified. */
  invoiceSortLines: ep('invoice', 'sortlines'),
  /** Adding/deleting lines IS on the line controller. Verified. */
  invoiceLineAdd: ep('invoiceline', 'add'),
  invoiceLineDelete: ep('invoiceline', 'delete'),

  // ── Subscriptions ─────────────────────────────────────────────────────────
  // NOTE: no delete action — `terminate` is the only removal path.
  subscriptionList: ep('subscription', 'list'),
  subscriptionShow: ep('subscription', 'show'),
  subscriptionAdd: ep('subscription', 'add'),
  subscriptionEdit: ep('subscription', 'edit'),
  subscriptionTerminate: ep('subscription', 'terminate'),

  // ── Price quotes ──────────────────────────────────────────────────────────
  priceQuoteList: ep('pricequote', 'list'),
  priceQuoteShow: ep('pricequote', 'show'),
  priceQuoteAdd: ep('pricequote', 'add'),
  priceQuoteEdit: ep('pricequote', 'edit'),
  priceQuoteDelete: ep('pricequote', 'delete'),
  priceQuoteDownload: ep('pricequote', 'download'),
  priceQuoteAccept: ep('pricequote', 'accept'),
  priceQuoteDecline: ep('pricequote', 'decline'),
  priceQuoteArchive: ep('pricequote', 'archive'),
  priceQuoteSchedule: ep('pricequote', 'schedule'),
  priceQuoteCancelSchedule: ep('pricequote', 'cancelschedule'),
  /** THIS EMAILS THE CUSTOMER. */
  priceQuoteSendByEmail: ep('pricequote', 'sendbyemail'),

  /** Sorting on the parent, same trap as invoices. Verified. */
  priceQuoteSortLines: ep('pricequote', 'sortlines'),
  priceQuoteLineAdd: ep('pricequoteline', 'add'),
  priceQuoteLineDelete: ep('pricequoteline', 'delete'),

  // ── Credit invoices (inkoopfacturen / purchase invoices) ──────────────────
  // NOTE: no download and no sendbyemail — verified, both "Invalid action".
  creditInvoiceList: ep('creditinvoice', 'list'),
  creditInvoiceShow: ep('creditinvoice', 'show'),
  creditInvoiceAdd: ep('creditinvoice', 'add'),
  creditInvoiceEdit: ep('creditinvoice', 'edit'),
  creditInvoiceDelete: ep('creditinvoice', 'delete'),
  creditInvoiceMarkAsPaid: ep('creditinvoice', 'markaspaid'),
  creditInvoicePartPayment: ep('creditinvoice', 'partpayment'),
  /** No sortlines action exists for purchase invoices. */
  creditInvoiceLineAdd: ep('creditinvoiceline', 'add'),
  creditInvoiceLineDelete: ep('creditinvoiceline', 'delete'),

  // ── Bank transactions ─────────────────────────────────────────────────────
  // NOTE: no edit action — verified, "Invalid action". Transactions are create-only.
  transactionList: ep('transaction', 'list'),
  transactionShow: ep('transaction', 'show'),
  transactionAdd: ep('transaction', 'add'),
  transactionMatch: ep('transaction', 'match'),
  transactionDelete: ep('transaction', 'delete'),
  transactionIgnore: ep('transaction', 'ignore'),

  // ── CRM: tasks & interactions ─────────────────────────────────────────────
  // NOTE: neither entity has a delete action.
  taskList: ep('task', 'list'),
  taskShow: ep('task', 'show'),
  taskAdd: ep('task', 'add'),
  taskEdit: ep('task', 'edit'),
  taskChangeStatus: ep('task', 'changestatus'),

  /** `interaction/list` REQUIRES referenceId + referenceType. Verified. */
  interactionList: ep('interaction', 'list'),
  interactionShow: ep('interaction', 'show'),
  interactionAdd: ep('interaction', 'add'),
  interactionEdit: ep('interaction', 'edit'),

  // ── Attachments (all parent types share one controller) ───────────────────
  attachmentAdd: ep('attachment', 'add'),
  attachmentDelete: ep('attachment', 'delete'),
  /** Returns a POSITIONAL array under `success`: [id, filename, base64, mimetype]. */
  attachmentDownload: ep('attachment', 'download'),
} as const satisfies Record<string, Endpoint>;

export type EndpointName = keyof typeof EP;

import { describe, it, expect, beforeEach } from 'vitest';
import { registerAllTools } from '../../src/register-tools.js';
import { harness, type Harness } from '../helpers/mcp-harness.js';
import { RecordingClient } from '../helpers/recording-client.js';
import { withEnv, WRITES_ON, WRITES_AND_SEND_ON } from '../helpers/env.js';

/**
 * Every branch of every consolidated tool's `action`/`type` dispatch.
 *
 * These tools each fold several WeFact endpoints behind one enum, which is what
 * keeps the tool surface small enough for an agent to choose from. The cost is
 * that a mis-wired arm of a switch is invisible: the tool still exists, still
 * validates, still returns a plausible result — it just calls the wrong
 * endpoint. That is exactly how the `sortlines` bug survived until it was
 * probed against the live API.
 *
 * So the assertion throughout is the resulting `controller/action` route, plus
 * whichever parameter distinguishes the arm. Not "does it forward every field"
 * — that would transcribe the implementation into a second file.
 */

let h: Harness;

beforeEach(async () => {
  if (h) await h.close();
  h = await harness(registerAllTools, new RecordingClient());
});

/** Run a write tool with both gates open and `confirm`, and return its route. */
async function route(name: string, args: Record<string, unknown>): Promise<string> {
  h.wefact.reset();
  const r = await withEnv(WRITES_AND_SEND_ON, () => h.call(name, { ...args, confirm: true }));
  if (r.isError) throw new Error(`${name} errored: ${String(r.body?.error)}`);
  return h.wefact.route;
}

/** Run a read tool and return its route. */
async function readRoute(name: string, args: Record<string, unknown>): Promise<string> {
  h.wefact.reset();
  const r = await h.call(name, args);
  if (r.isError) throw new Error(`${name} errored: ${String(r.body?.error)}`);
  return h.wefact.route;
}

async function failure(name: string, args: Record<string, unknown>): Promise<string> {
  h.wefact.reset();
  const r = await withEnv(WRITES_AND_SEND_ON, () => h.call(name, { ...args, confirm: true }));
  expect(r.isError, `${name} was expected to fail`).toBe(true);
  expect(h.wefact.calls, 'a rejected call must not reach the API').toHaveLength(0);
  return String(r.body?.error);
}

describe('save_* add versus edit', () => {
  it.each([
    ['save_debtor', { CompanyName: 'X' }, 'debtor'],
    ['save_creditor', { CompanyName: 'X' }, 'creditor'],
    ['save_product', { ProductName: 'X', ProductKeyPhrase: 'Y', PriceExcl: 1 }, 'product'],
  ])('%s routes to %s add and edit', async (name, fields, controller) => {
    expect(await route(name, { action: 'add', ...fields })).toBe(`${controller}/add`);
    expect(await route(name, { action: 'edit', identifier: 1, ...fields })).toBe(`${controller}/edit`);
  });

  it('save_invoice routes to invoice add and edit', async () => {
    const lines = [{ Description: 'x', PriceExcl: 1 }];
    expect(await route('save_invoice', { action: 'add', DebtorCode: 'DB1', InvoiceLines: lines })).toBe('invoice/add');
    expect(await route('save_invoice', { action: 'edit', identifier: 1 })).toBe('invoice/edit');
  });

  it('save_price_quote routes to pricequote add and edit', async () => {
    const lines = [{ Description: 'x', PriceExcl: 1 }];
    expect(await route('save_price_quote', { action: 'add', DebtorCode: 'DB1', PriceQuoteLines: lines })).toBe(
      'pricequote/add',
    );
    expect(await route('save_price_quote', { action: 'edit', identifier: 1 })).toBe('pricequote/edit');
  });

  it('save_credit_invoice routes to creditinvoice add and edit', async () => {
    const lines = [{ Description: 'x', PriceExcl: 1 }];
    expect(
      await route('save_credit_invoice', {
        action: 'add',
        CreditorCode: 'CD1',
        InvoiceCode: 'S-1',
        InvoiceLines: lines,
      }),
    ).toBe('creditinvoice/add');
    expect(await route('save_credit_invoice', { action: 'edit', identifier: 1 })).toBe('creditinvoice/edit');
  });

  it('save_subscription routes to subscription add and edit', async () => {
    expect(await route('save_subscription', { action: 'add', DebtorCode: 'DB1', ProductCode: 'P1' })).toBe(
      'subscription/add',
    );
    expect(await route('save_subscription', { action: 'edit', identifier: 1, PriceExcl: 5 })).toBe('subscription/edit');
  });

  it('rejects an edit with no way to identify the record', async () => {
    expect(await failure('save_debtor', { action: 'edit', CompanyName: 'X' })).toMatch(/identifier|DebtorCode/);
    expect(await failure('save_subscription', { action: 'edit' })).toMatch(/identifier/);
  });
});

describe('register_payment', () => {
  it.each([
    ['partial', 'invoice/partpayment', { amountPaid: 10 }],
    ['paid', 'invoice/markaspaid', {}],
    ['unpaid', 'invoice/markasunpaid', {}],
  ])('sales invoice %s → %s', async (action, expected, extra) => {
    expect(await route('register_payment', { action, identifier: 1, ...extra })).toBe(expected);
  });

  it.each([
    ['partial', 'creditinvoice/partpayment', { amountPaid: 10 }],
    ['paid', 'creditinvoice/markaspaid', {}],
  ])('purchase invoice %s → %s', async (action, expected, extra) => {
    expect(await route('register_payment', { action, type: 'creditinvoice', identifier: 1, ...extra })).toBe(expected);
  });

  it('refuses to reverse a purchase invoice — WeFact has no such action', async () => {
    expect(await failure('register_payment', { action: 'unpaid', type: 'creditinvoice', identifier: 1 })).toMatch(
      /no "unpaid" action for purchase invoices/,
    );
  });

  it('requires an amount for a partial payment', async () => {
    expect(await failure('register_payment', { action: 'partial', identifier: 1 })).toMatch(/amountPaid/);
  });
});

describe('set_invoice_state', () => {
  it.each([
    ['block', 'invoice/block'],
    ['unblock', 'invoice/unblock'],
    ['pause', 'invoice/paymentprocesspause'],
    ['reactivate', 'invoice/paymentprocessreactivate'],
  ])('%s → %s', async (action, expected) => {
    expect(await route('set_invoice_state', { action, identifier: 1 })).toBe(expected);
  });

  it('sends the pause detail fields only when pausing', async () => {
    await route('set_invoice_state', {
      action: 'pause',
      identifier: 1,
      pausedUntil: '2026-12-31',
      pausedReason: 'dispute',
      disableOnlinePayment: 'yes',
    });
    expect(h.wefact.params).toMatchObject({
      PaymentPausedEndDate: '2026-12-31',
      // WeFact's parameter table lowercases the r; the working spelling is this one.
      PaymentPausedReason: 'dispute',
      DisableOnlinePayment: 'yes',
    });

    await route('set_invoice_state', { action: 'block', identifier: 1, pausedReason: 'ignored' });
    expect(Object.keys(h.wefact.params)).not.toContain('PaymentPausedReason');
  });
});

describe('set_price_quote_status', () => {
  it.each([
    ['accept', 'pricequote/accept'],
    ['decline', 'pricequote/decline'],
    ['archive', 'pricequote/archive'],
  ])('%s → %s', async (action, expected) => {
    expect(await route('set_price_quote_status', { action, identifier: 1 })).toBe(expected);
  });

  it('maps the accept booleans onto WeFact’s yes/no strings', async () => {
    await route('set_price_quote_status', {
      action: 'accept',
      identifier: 1,
      createInvoice: true,
      useQuoteCodeAsReference: false,
      useTodayForLineDates: true,
    });
    expect(h.wefact.params).toMatchObject({
      CreateInvoice: 'yes',
      // Note the capitalised "AS" — WeFact spells the parameter that way.
      UsePriceQuoteCodeASInvoiceReference: 'no',
      UseTodayAsInvoiceLinesDate: 'yes',
    });
  });

  it('sends no accept options when declining', async () => {
    await route('set_price_quote_status', { action: 'decline', identifier: 1, createInvoice: true });
    expect(Object.keys(h.wefact.params)).not.toContain('CreateInvoice');
  });
});

describe('delete_record', () => {
  it.each([
    ['creditor', 'creditor/delete'],
    ['product', 'product/delete'],
    ['invoice', 'invoice/delete'],
    ['creditinvoice', 'creditinvoice/delete'],
    ['pricequote', 'pricequote/delete'],
    ['transaction', 'transaction/delete'],
  ])('%s → %s', async (type, expected) => {
    expect(await route('delete_record', { type, identifier: 1 })).toBe(expected);
  });

  it('accepts a code for the types that have one', async () => {
    await route('delete_record', { type: 'product', code: 'P0001' });
    expect(h.wefact.params).toEqual({ ProductCode: 'P0001' });
  });

  it('rejects a code for transactions, which have none', async () => {
    expect(await failure('delete_record', { type: 'transaction', code: 'nope' })).toMatch(/not supported/);
  });

  it('requires an identifier for transactions', async () => {
    expect(await failure('delete_record', { type: 'transaction' })).toMatch(/identifier/);
  });

  it('passes the cascade flag only for creditors', async () => {
    await route('delete_record', { type: 'creditor', identifier: 1, withPurchaseInvoices: true });
    expect(h.wefact.params['withcreditinvoice']).toBe('yes');

    await route('delete_record', { type: 'creditor', identifier: 1, withPurchaseInvoices: false });
    expect(h.wefact.params['withcreditinvoice']).toBe('no');
  });
});

describe('save_crm_record', () => {
  it.each([
    ['task', 'add', { title: 'T' }, 'task/add'],
    ['task', 'edit', { identifier: 1, title: 'T' }, 'task/edit'],
    ['task', 'status', { identifier: 1, status: 'completed' }, 'task/changestatus'],
  ])('%s %s → %s', async (type, action, args, expected) => {
    expect(await route('save_crm_record', { type, action, ...args })).toBe(expected);
  });

  const interaction = { assigneeId: 1, description: 'D', communicationMethod: 'phone', debtorId: 1 };

  it('routes interaction add and edit', async () => {
    expect(await route('save_crm_record', { type: 'interaction', action: 'add', ...interaction })).toBe(
      'interaction/add',
    );
    expect(await route('save_crm_record', { type: 'interaction', action: 'edit', identifier: 1, ...interaction })).toBe(
      'interaction/edit',
    );
  });

  it('maps Hours/Minutes onto the right date field per entity', async () => {
    await route('save_crm_record', { type: 'task', action: 'add', title: 'T', dueDate: '2026-08-01', hours: '14' });
    expect(h.wefact.params).toMatchObject({ DueAt: '2026-08-01', Hours: '14' });

    await route('save_crm_record', { type: 'interaction', action: 'add', ...interaction, dueDate: '2026-08-01' });
    expect(h.wefact.params).toMatchObject({ Date: '2026-08-01' });
  });

  it('refuses a status change on an interaction', async () => {
    expect(await failure('save_crm_record', { type: 'interaction', action: 'status', identifier: 1 })).toMatch(
      /tasks only/,
    );
  });

  it('requires a status for a status change', async () => {
    expect(await failure('save_crm_record', { type: 'task', action: 'status', identifier: 1 })).toMatch(/status/);
  });

  it('requires a title for a new task', async () => {
    expect(await failure('save_crm_record', { type: 'task', action: 'add' })).toMatch(/title/);
  });

  it('names every missing field when creating an interaction', async () => {
    const error = await failure('save_crm_record', { type: 'interaction', action: 'add' });
    expect(error).toContain('assigneeId');
    expect(error).toContain('description');
    expect(error).toContain('communicationMethod');
  });

  it('requires an interaction to be linked to something', async () => {
    expect(
      await failure('save_crm_record', {
        type: 'interaction',
        action: 'add',
        assigneeId: 1,
        description: 'D',
        communicationMethod: 'phone',
      }),
    ).toMatch(/at least one link/);
  });
});

describe('manage_debtor_contacts', () => {
  it.each([
    ['add', { debtorCode: 'DB1', LastName: 'X' }, 'extraclientcontact/add'],
    ['edit', { identifier: 1, LastName: 'X' }, 'extraclientcontact/edit'],
    ['delete', { identifier: 1 }, 'extraclientcontact/delete'],
  ])('%s → %s', async (action, args, expected) => {
    expect(await route('manage_debtor_contacts', { action, ...args })).toBe(expected);
  });

  it('requires a parent customer when adding', async () => {
    expect(await failure('manage_debtor_contacts', { action: 'add', LastName: 'X' })).toMatch(/clientId|debtorCode/);
  });

  it('requires an identifying field when adding', async () => {
    expect(await failure('manage_debtor_contacts', { action: 'add', debtorCode: 'DB1' })).toMatch(/CompanyName/);
  });

  it('explains that WeFact re-validates the identifying trio on edit', async () => {
    // WeFact's own error does not make clear that it applies to partial updates.
    expect(await failure('manage_debtor_contacts', { action: 'edit', identifier: 1, PhoneNumber: '010' })).toMatch(
      /even when changing another field/,
    );
  });

  it('sends no field payload when deleting', async () => {
    await route('manage_debtor_contacts', { action: 'delete', identifier: 1 });
    expect(h.wefact.params).toEqual({ Identifier: 1 });
  });
});

describe('manage_group and manage_cost_category', () => {
  it.each([
    ['add', { type: 'debtor', groupName: 'G' }, 'group/add'],
    ['edit', { identifier: 1, groupName: 'G' }, 'group/edit'],
    ['delete', { identifier: 1 }, 'group/delete'],
  ])('manage_group %s → %s', async (action, args, expected) => {
    expect(await route('manage_group', { action, ...args })).toBe(expected);
  });

  it('manage_group requires type and name on add', async () => {
    expect(await failure('manage_group', { action: 'add', groupName: 'G' })).toMatch(/type.*groupName/);
  });

  it('manage_group requires an identifier on edit and delete', async () => {
    expect(await failure('manage_group', { action: 'edit', groupName: 'G' })).toMatch(/identifier/);
  });

  it.each([
    ['add', { title: 'C' }, 'settings/costcategory_add'],
    ['edit', { identifier: 1, title: 'C' }, 'settings/costcategory_edit'],
    ['delete', { identifier: 1 }, 'settings/costcategory_delete'],
  ])('manage_cost_category %s → %s', async (action, args, expected) => {
    expect(await route('manage_cost_category', { action, ...args })).toBe(expected);
  });

  it('manage_cost_category requires a title on add and an id otherwise', async () => {
    expect(await failure('manage_cost_category', { action: 'add' })).toMatch(/title/);
    expect(await failure('manage_cost_category', { action: 'edit', title: 'C' })).toMatch(/identifier/);
  });
});

describe('subscription termination', () => {
  it('routes to terminate for a date and for a count', async () => {
    expect(await route('terminate_subscription', { identifier: 1, terminationDate: '2026-12-31' })).toBe(
      'subscription/terminate',
    );
    expect(h.wefact.params['Subscription']).toEqual({ TerminationDate: '2026-12-31' });

    await route('terminate_subscription', { identifier: 1, terminateAfter: 3 });
    expect(h.wefact.params['Subscription']).toEqual({ TerminateAfter: 3 });
  });

  it('clears the termination date when undoing', async () => {
    await route('terminate_subscription', { identifier: 1, undo: true });
    expect(h.wefact.params['Subscription']).toEqual({ TerminationDate: '' });
  });

  it('refuses undo combined with a termination', async () => {
    expect(await failure('terminate_subscription', { identifier: 1, undo: true, terminateAfter: 1 })).toMatch(/undo/);
  });

  it('requires one of the three options', async () => {
    expect(await failure('terminate_subscription', { identifier: 1 })).toMatch(/terminationDate/);
  });

  it('refuses two conflicting end conditions on save', async () => {
    expect(
      await failure('save_subscription', {
        action: 'add',
        DebtorCode: 'DB1',
        ProductCode: 'P1',
        TerminationDate: '2026-12-31',
        TerminateAfter: 3,
      }),
    ).toMatch(/not both/);
  });
});

describe('sending and scheduling', () => {
  it('routes the two dunning levels', async () => {
    expect(await route('send_invoice_reminder', { level: 'reminder', identifier: 1 })).toBe(
      'invoice/sendreminderbyemail',
    );
    expect(await route('send_invoice_reminder', { level: 'summation', identifier: 1 })).toBe(
      'invoice/sendsummationbyemail',
    );
  });

  it.each([
    ['schedule', 'invoice', 'invoice/schedule'],
    ['cancel', 'invoice', 'invoice/cancelschedule'],
    ['schedule', 'pricequote', 'pricequote/schedule'],
    ['cancel', 'pricequote', 'pricequote/cancelschedule'],
  ])('schedule_document_send %s %s → %s', async (action, type, expected) => {
    const args: Record<string, unknown> = { action, type, identifier: 1 };
    if (action === 'schedule') args['sendAt'] = '2099-01-01 09:00:00';
    expect(await route('schedule_document_send', args)).toBe(expected);
  });

  it('requires a moment to schedule', async () => {
    expect(await failure('schedule_document_send', { action: 'schedule', type: 'invoice', identifier: 1 })).toMatch(
      /sendAt/,
    );
  });

  it('sends no ScheduledAt when cancelling', async () => {
    await route('schedule_document_send', { action: 'cancel', type: 'invoice', identifier: 1 });
    expect(Object.keys(h.wefact.params)).not.toContain('ScheduledAt');
  });
});

describe('manage_attachments', () => {
  it.each([
    ['debtor', 'DebtorCode'],
    ['creditor', 'CreditorCode'],
    ['invoice', 'InvoiceCode'],
    ['pricequote', 'PriceQuoteCode'],
    ['creditinvoice', 'CreditInvoiceCode'],
  ])('accepts a code for %s parents', async (type, codeField) => {
    await route('manage_attachments', { action: 'add', type, code: 'X-1', filename: 'a.pdf', base64: 'AA==' });
    expect(h.wefact.params).toMatchObject({ Type: type, [codeField]: 'X-1' });
  });

  it.each(['crm_task', 'crm_interaction'])('requires an identifier for %s, which has no code', async (type) => {
    expect(
      await failure('manage_attachments', { action: 'add', type, code: 'X-1', filename: 'a.pdf', base64: 'AA==' }),
    ).toMatch(/no code lookup|not supported/);

    await route('manage_attachments', { action: 'add', type, identifier: 5, filename: 'a.pdf', base64: 'AA==' });
    expect(h.wefact.params).toMatchObject({ Type: type, ReferenceIdentifier: 5 });
  });

  it('routes delete and identifies the file by id or name', async () => {
    expect(
      await route('manage_attachments', { action: 'delete', type: 'invoice', identifier: 1, attachmentId: 9 }),
    ).toBe('attachment/delete');
    expect(h.wefact.params).toMatchObject({ Identifier: 9 });

    await route('manage_attachments', { action: 'delete', type: 'invoice', identifier: 1, filename: 'a.pdf' });
    expect(h.wefact.params).toMatchObject({ Filename: 'a.pdf' });
  });

  it('requires the file contents when adding', async () => {
    expect(await failure('manage_attachments', { action: 'add', type: 'invoice', identifier: 1 })).toMatch(
      /filename.*base64/,
    );
  });

  it('requires a way to identify the file when deleting', async () => {
    expect(await failure('manage_attachments', { action: 'delete', type: 'invoice', identifier: 1 })).toMatch(
      /attachmentId.*filename/,
    );
  });

  it('summarises the payload in the dry-run instead of echoing the base64', async () => {
    h.wefact.reset();
    const r = await withEnv(WRITES_ON, () =>
      h.call('manage_attachments', {
        action: 'add',
        type: 'invoice',
        identifier: 1,
        filename: 'a.pdf',
        base64: 'QUJDREVGR0g=',
      }),
    );
    const planned = r.body?.['plannedAttachment'] as Record<string, unknown>;
    expect(String(planned['Base64'])).toMatch(/bytes of base64, omitted/);
  });
});

describe('download_document', () => {
  it('routes each document type', async () => {
    expect(await readRoute('download_document', { type: 'invoice', identifier: 1 })).toBe('invoice/download');
    expect(await readRoute('download_document', { type: 'pricequote', identifier: 1 })).toBe('pricequote/download');
    expect(
      await readRoute('download_document', {
        type: 'attachment',
        parentType: 'invoice',
        identifier: 1,
        filename: 'a.pdf',
      }),
    ).toBe('attachment/download');
  });

  it('passes the invoice file type and template through', async () => {
    await readRoute('download_document', { type: 'invoice', identifier: 1, fileType: 'ubl', template: 'workorder' });
    expect(h.wefact.params).toMatchObject({ FileType: 'ubl', InvoiceTemplateType: 'workorder' });
  });

  it('selects the code field matching the document type', async () => {
    // The route alone does not prove this: `codeField` decides the parameter
    // name, so sending PriceQuoteCode as InvoiceCode would still reach
    // pricequote/download and simply never find the quote.
    await readRoute('download_document', { type: 'invoice', code: 'F2026-0001' });
    expect(h.wefact.params).toEqual({ InvoiceCode: 'F2026-0001' });

    await readRoute('download_document', { type: 'pricequote', code: 'OF2026-0001' });
    expect(h.wefact.params).toEqual({ PriceQuoteCode: 'OF2026-0001' });
  });

  it('sends no file options for a quote — they are invoice-only', async () => {
    await readRoute('download_document', { type: 'pricequote', identifier: 1, fileType: 'ubl' });
    expect(Object.keys(h.wefact.params)).not.toContain('FileType');
  });

  it('normalises the named-key response shape', async () => {
    h.wefact.reset().reply({ invoice: { Filename: 'F.pdf', Base64: 'AAA=', MimeType: 'application/pdf' } });
    const r = await h.call('download_document', { type: 'invoice', identifier: 1 });
    expect(r.body?.['document']).toEqual({ filename: 'F.pdf', base64: 'AAA=', mimeType: 'application/pdf' });
  });

  it('normalises the positional attachment response into the same shape', async () => {
    // attachment/download returns [id, filename, base64, mimetype] under
    // `success` — a different shape from every other download.
    h.wefact.reset().reply({ success: [123, 'a.pdf', 'AAA=', 'application/pdf'] });
    const r = await h.call('download_document', {
      type: 'attachment',
      parentType: 'invoice',
      identifier: 1,
      filename: 'a.pdf',
    });
    expect(r.body?.['document']).toEqual({
      attachmentId: 123,
      filename: 'a.pdf',
      base64: 'AAA=',
      mimeType: 'application/pdf',
    });
  });

  it('requires a parent type for attachments', async () => {
    h.wefact.reset();
    const r = await h.call('download_document', { type: 'attachment', identifier: 1, filename: 'a.pdf' });
    expect(r.isError).toBe(true);
    expect(String(r.body?.error)).toMatch(/parentType/);
  });

  it('requires a way to identify the attachment', async () => {
    h.wefact.reset();
    const r = await h.call('download_document', { type: 'attachment', parentType: 'invoice', identifier: 1 });
    expect(r.isError).toBe(true);
    expect(String(r.body?.error)).toMatch(/attachmentId.*filename/);
  });

  it('requires a way to identify the parent', async () => {
    h.wefact.reset();
    const r = await h.call('download_document', { type: 'attachment', parentType: 'crm_task', filename: 'a.pdf' });
    expect(r.isError).toBe(true);
    expect(String(r.body?.error)).toMatch(/no code lookup|identifier/);
  });
});

describe('get_settings sections', () => {
  it('reads the general section by default', async () => {
    expect(await readRoute('get_settings', {})).toBe('settings/list');
  });

  it('lists cost categories', async () => {
    expect(await readRoute('get_settings', { section: 'cost_categories' })).toBe('settings/costcategory_list');
  });

  it('reads a single cost category', async () => {
    expect(await readRoute('get_settings', { section: 'cost_categories', costCategoryId: 3 })).toBe(
      'settings/costcategory_show',
    );
    expect(h.wefact.params).toEqual({ Identifier: 3 });
  });

  it('passes the status filter through', async () => {
    await readRoute('get_settings', { section: 'cost_categories', status: 'active|removed' });
    expect(h.wefact.params).toMatchObject({ status: 'active|removed' });
  });
});

describe('list_groups', () => {
  it('lists by type and reads one by id', async () => {
    expect(await readRoute('list_groups', { type: 'debtor' })).toBe('group/list');
    expect(await readRoute('list_groups', { type: 'debtor', identifier: 2 })).toBe('group/show');
  });

  it('keeps its own offset and limit, which it genuinely honours', async () => {
    // The only list tool that pages by hand rather than through paginate().
    await readRoute('list_groups', { type: 'product', offset: 10, limit: 5 });
    expect(h.wefact.params).toMatchObject({ type: 'product', offset: 10, limit: 5 });
  });
});

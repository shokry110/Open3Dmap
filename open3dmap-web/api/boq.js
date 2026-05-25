/**
 * BOQ (Bill of Quantities) API — ES-module request handler
 *
 * Provides a handleRequest(req, res) function that processes all
 * /api/boq/* routes. Mount it from server.js with:
 *
 *   import { handleRequest as handleBoqRequest } from './api/boq.js';
 *   // In createServer callback:
 *   if (pathname.startsWith('/api/boq')) { handleBoqRequest(req, res); return; }
 *
 * Endpoints:
 *   POST   /api/boq                        – create BOQ
 *   GET    /api/boq                        – list BOQs
 *   GET    /api/boq/:id                    – get BOQ
 *   PUT    /api/boq/:id                    – update BOQ metadata
 *   DELETE /api/boq/:id                    – delete BOQ
 *   POST   /api/boq/:id/items              – add line item
 *   PUT    /api/boq/:id/items/:itemId      – update line item
 *   DELETE /api/boq/:id/items/:itemId      – remove line item
 *   POST   /api/boq/calculate              – calculate totals (no persist)
 *   GET    /api/boq/hubspot/contacts       – fetch HubSpot contacts
 *   POST   /api/boq/:id/push-hubspot       – push BOQ to HubSpot
 *   POST   /api/boq/:id/finalise           – lock BOQ
 *   POST   /api/boq/:id/toggle-vat         – toggle 5 % VAT
 *   GET    /api/boq/:id/pdf                – printable HTML / PDF
 */

// ---------------------------------------------------------------------------
// In-memory store (replace with Firestore / DB in production)
// ---------------------------------------------------------------------------
const boqStore = new Map(); // boqId -> BOQ document

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/** Generate a short random ID */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Calculate a single line item.
 * @param {object} item - { description, qty, unit, unitPrice, pricingType }
 *   pricingType: 'per_sqm' | 'per_piece'
 * @returns {object} item enriched with lineTotal
 */
export function calculateLineItem(item) {
  const qty       = parseFloat(item.qty)       || 0;
  const unitPrice = parseFloat(item.unitPrice) || 0;
  const lineTotal = parseFloat((qty * unitPrice).toFixed(2));
  return { ...item, qty, unitPrice, lineTotal };
}

/**
 * Derive BOQ totals from its line items.
 * @param {object[]} items
 * @param {boolean}  includeVat
 * @returns {{ subTotal, vatAmount, grandTotal }}
 */
export function deriveTotals(items, includeVat) {
  const subTotal  = parseFloat(items.reduce((s, i) => s + (i.lineTotal || 0), 0).toFixed(2));
  const vatRate   = 0.05; // 5 %
  const vatAmount = includeVat ? parseFloat((subTotal * vatRate).toFixed(2)) : 0;
  const grandTotal = parseFloat((subTotal + vatAmount).toFixed(2));
  return { subTotal, vatAmount, grandTotal };
}

/**
 * Build a new BOQ document skeleton.
 * @param {object} payload
 */
export function newBoqDocument(payload = {}) {
  const now = new Date().toISOString();
  return {
    id          : generateId(),
    title       : payload.title       || 'Untitled BOQ',
    companyName : payload.companyName || '',
    companyLogo : payload.companyLogo || '',
    clientName  : payload.clientName  || '',
    clientEmail : payload.clientEmail || '',
    clientPhone : payload.clientPhone || '',
    hubspotContactId: payload.hubspotContactId || null,
    includeVat  : payload.includeVat !== undefined ? Boolean(payload.includeVat) : true,
    status      : 'draft', // draft | finalised
    items       : [],
    services    : [],   // extra service/condition columns (flexible schema)
    subTotal    : 0,
    vatAmount   : 0,
    grandTotal  : 0,
    createdAt   : now,
    updatedAt   : now,
  };
}

// ---------------------------------------------------------------------------
// HubSpot helpers
// ---------------------------------------------------------------------------

const HUBSPOT_BASE = 'https://api.hubapi.com';

function hubspotHeaders() {
  const apiKey = process.env.HUBSPOT_API_KEY || '';
  if (!apiKey) {
    throw new Error('HUBSPOT_API_KEY environment variable is not set');
  }
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type' : 'application/json',
  };
}

async function fetchHubspotContacts(limit = 20) {
  const headers = hubspotHeaders(); // throws early if no API key
  const url = `${HUBSPOT_BASE}/crm/v3/objects/contacts?limit=${limit}&properties=firstname,lastname,email,phone,company`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot contacts fetch failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return (data.results || []).map(c => ({
    id      : c.id,
    name    : `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim() || c.id,
    email   : c.properties.email   || '',
    phone   : c.properties.phone   || '',
    company : c.properties.company || '',
  }));
}

async function pushBoqToHubspot(boq) {
  const noteBody = buildHubspotNoteBody(boq);
  const headers  = hubspotHeaders(); // throws early if no API key

  const payload = {
    properties: {
      hs_note_body : noteBody,
      hs_timestamp : Date.now(),
    },
  };

  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
    method  : 'POST',
    headers,
    body    : JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot push failed (${res.status}): ${body}`);
  }

  const note = await res.json();

  // Associate the note with the contact when we have an ID
  if (boq.hubspotContactId) {
    const assocUrl = `${HUBSPOT_BASE}/crm/v3/objects/notes/${note.id}/associations/contacts/${boq.hubspotContactId}/note_to_contact`;
    const assocRes = await fetch(assocUrl, { method: 'PUT', headers });
    if (!assocRes.ok) {
      console.warn('BOQ: Failed to associate note with contact', await assocRes.text());
    }
  }

  return note;
}

function buildHubspotNoteBody(boq) {
  const lines = boq.items
    .map((item, i) =>
      `${i + 1}. ${item.description} | Qty: ${item.qty} ${item.unit || ''} | Unit Price: ${item.unitPrice} | Total: ${item.lineTotal}`
    )
    .join('\n');

  return [
    `BOQ: ${boq.title}`,
    `Client: ${boq.clientName}`,
    `Status: ${boq.status}`,
    `Date: ${new Date().toLocaleDateString()}`,
    '',
    'Items:',
    lines,
    '',
    `Sub-Total  : ${boq.subTotal}`,
    `VAT (5%)   : ${boq.vatAmount}`,
    `Grand Total: ${boq.grandTotal}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers — request body parsing, routing
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const json = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type'                : 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin' : '*',
  });
  res.end(html);
}

// ---------------------------------------------------------------------------
// PDF builder
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPdfHtml(boq) {
  const rows = boq.items.map((item, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(item.description || '')}</td>
      <td>${escapeHtml(item.pricingType === 'per_sqm' ? 'm²' : (item.unit || 'pc'))}</td>
      <td class="num">${item.qty}</td>
      <td class="num">${item.unitPrice}</td>
      <td class="num">${item.lineTotal}</td>
    </tr>`).join('');

  const logoHtml = boq.companyLogo
    ? `<img src="${escapeHtml(boq.companyLogo)}" alt="Company Logo" class="logo">`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>BOQ – ${escapeHtml(boq.title)}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 12px; color: #222; margin: 30px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
    .logo { max-height: 60px; }
    .company-info h2 { margin: 0 0 4px; font-size: 16px; }
    .client-section { border-top: 1px solid #ccc; padding-top: 12px; margin-bottom: 20px; }
    h1 { font-size: 18px; text-align: center; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #f0f0f0; border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
    td { border: 1px solid #ccc; padding: 5px 8px; }
    .num { text-align: right; }
    .totals { width: 300px; margin-left: auto; }
    .totals td { border: none; padding: 3px 8px; }
    .totals .label { font-weight: bold; }
    .grand { font-weight: bold; font-size: 13px; border-top: 2px solid #222; }
    @media print { button { display: none; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-info">
      ${logoHtml}
      <h2>${escapeHtml(boq.companyName || 'Company Name')}</h2>
    </div>
    <div style="text-align:right;">
      <strong>Date:</strong> ${new Date().toLocaleDateString()}<br>
      <strong>Status:</strong> ${escapeHtml(boq.status)}
    </div>
  </div>

  <h1>Bill of Quantities — ${escapeHtml(boq.title)}</h1>

  <div class="client-section">
    <strong>Client:</strong> ${escapeHtml(boq.clientName || 'N/A')}<br>
    ${boq.clientEmail ? `<strong>Email:</strong> ${escapeHtml(boq.clientEmail)}<br>` : ''}
    ${boq.clientPhone ? `<strong>Phone:</strong> ${escapeHtml(boq.clientPhone)}` : ''}
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Description</th>
        <th>Unit</th>
        <th class="num">Quantity</th>
        <th class="num">Unit Price</th>
        <th class="num">Line Total</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="6" style="text-align:center;">No items</td></tr>'}
    </tbody>
  </table>

  <table class="totals">
    <tr><td class="label">Sub-Total</td><td class="num">${boq.subTotal}</td></tr>
    ${boq.includeVat ? `<tr><td class="label">VAT (5%)</td><td class="num">${boq.vatAmount}</td></tr>` : ''}
    <tr class="grand"><td class="label">Grand Total</td><td class="num">${boq.grandTotal}</td></tr>
  </table>

  <button onclick="window.print()" style="margin-top:20px;padding:8px 16px;cursor:pointer;">Print / Save as PDF</button>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main request handler — routes all /api/boq/* requests
// ---------------------------------------------------------------------------

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 */
export async function handleRequest(req, res) {
  const method   = req.method.toUpperCase();
  const rawPath  = new URL(req.url, 'http://localhost').pathname;

  // Strip /api/boq prefix to get the sub-path
  const subPath  = rawPath.replace(/^\/api\/boq/, '') || '/';

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  try {
    // -----------------------------------------------------------------------
    // POST /api/boq/calculate  (before /:id routes to avoid mis-routing)
    // -----------------------------------------------------------------------
    if (method === 'POST' && subPath === '/calculate') {
      const body       = await readBody(req);
      const rawItems   = Array.isArray(body.items) ? body.items : [];
      const includeVat = body.includeVat !== undefined ? Boolean(body.includeVat) : true;
      const items      = rawItems.map(calculateLineItem);
      const totals     = deriveTotals(items, includeVat);
      sendJson(res, 200, { success: true, items, ...totals });
      return;
    }

    // -----------------------------------------------------------------------
    // GET /api/boq/hubspot/contacts
    // -----------------------------------------------------------------------
    if (method === 'GET' && subPath === '/hubspot/contacts') {
      const qs    = new URL(req.url, 'http://localhost').searchParams;
      const limit = parseInt(qs.get('limit'), 10) || 20;
      try {
        const contacts = await fetchHubspotContacts(limit);
        sendJson(res, 200, { success: true, contacts });
      } catch (err) {
        const isConfig = err.message.includes('HUBSPOT_API_KEY');
        sendJson(res, isConfig ? 503 : 502, { success: false, error: err.message });
      }
      return;
    }

    // -----------------------------------------------------------------------
    // POST /api/boq  — create BOQ
    // -----------------------------------------------------------------------
    if (method === 'POST' && subPath === '/') {
      const body = await readBody(req);
      const doc  = newBoqDocument(body);
      boqStore.set(doc.id, doc);
      sendJson(res, 201, { success: true, boq: doc });
      return;
    }

    // -----------------------------------------------------------------------
    // GET /api/boq  — list BOQs
    // -----------------------------------------------------------------------
    if (method === 'GET' && subPath === '/') {
      const list = Array.from(boqStore.values()).sort(
        (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
      );
      sendJson(res, 200, { success: true, boqs: list });
      return;
    }

    // -----------------------------------------------------------------------
    // Routes that require an :id  — parse sub-path
    // -----------------------------------------------------------------------
    const parts = subPath.split('/').filter(Boolean); // e.g. ['abc', 'items', 'xyz']

    if (parts.length === 0) {
      sendJson(res, 404, { success: false, error: 'Not found' });
      return;
    }

    const boqId = parts[0];
    const rest  = parts.slice(1); // e.g. ['items', 'xyz'] or ['pdf'] etc.

    // GET/PUT/DELETE /api/boq/:id
    if (rest.length === 0) {
      if (method === 'GET') {
        const boq = boqStore.get(boqId);
        if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
        sendJson(res, 200, { success: true, boq });
        return;
      }
      if (method === 'PUT') {
        const boq = boqStore.get(boqId);
        if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
        const body    = await readBody(req);
        const allowed = ['title', 'companyName', 'companyLogo', 'clientName', 'clientEmail',
                         'clientPhone', 'hubspotContactId', 'includeVat', 'status', 'services'];
        allowed.forEach(key => { if (body[key] !== undefined) boq[key] = body[key]; });
        const totals = deriveTotals(boq.items, boq.includeVat);
        Object.assign(boq, totals, { updatedAt: new Date().toISOString() });
        boqStore.set(boq.id, boq);
        sendJson(res, 200, { success: true, boq });
        return;
      }
      if (method === 'DELETE') {
        if (!boqStore.has(boqId)) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
        boqStore.delete(boqId);
        sendJson(res, 200, { success: true, message: 'BOQ deleted' });
        return;
      }
    }

    // POST /api/boq/:id/items
    if (rest[0] === 'items' && rest.length === 1 && method === 'POST') {
      const boq = boqStore.get(boqId);
      if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
      if (boq.status === 'finalised') { sendJson(res, 400, { success: false, error: 'Cannot modify a finalised BOQ' }); return; }
      const body   = await readBody(req);
      const item   = calculateLineItem({ ...body, id: generateId() });
      boq.items.push(item);
      const totals = deriveTotals(boq.items, boq.includeVat);
      Object.assign(boq, totals, { updatedAt: new Date().toISOString() });
      boqStore.set(boq.id, boq);
      sendJson(res, 201, { success: true, item, totals });
      return;
    }

    // PUT /api/boq/:id/items/:itemId
    if (rest[0] === 'items' && rest.length === 2 && method === 'PUT') {
      const boq    = boqStore.get(boqId);
      const itemId = rest[1];
      if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
      if (boq.status === 'finalised') { sendJson(res, 400, { success: false, error: 'Cannot modify a finalised BOQ' }); return; }
      const idx = boq.items.findIndex(i => i.id === itemId);
      if (idx === -1) { sendJson(res, 404, { success: false, error: 'Item not found' }); return; }
      const body       = await readBody(req);
      boq.items[idx]   = calculateLineItem({ ...boq.items[idx], ...body, id: itemId });
      const totals     = deriveTotals(boq.items, boq.includeVat);
      Object.assign(boq, totals, { updatedAt: new Date().toISOString() });
      boqStore.set(boq.id, boq);
      sendJson(res, 200, { success: true, item: boq.items[idx], totals });
      return;
    }

    // DELETE /api/boq/:id/items/:itemId
    if (rest[0] === 'items' && rest.length === 2 && method === 'DELETE') {
      const boq    = boqStore.get(boqId);
      const itemId = rest[1];
      if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
      if (boq.status === 'finalised') { sendJson(res, 400, { success: false, error: 'Cannot modify a finalised BOQ' }); return; }
      const before = boq.items.length;
      boq.items    = boq.items.filter(i => i.id !== itemId);
      if (boq.items.length === before) { sendJson(res, 404, { success: false, error: 'Item not found' }); return; }
      const totals = deriveTotals(boq.items, boq.includeVat);
      Object.assign(boq, totals, { updatedAt: new Date().toISOString() });
      boqStore.set(boq.id, boq);
      sendJson(res, 200, { success: true, totals });
      return;
    }

    // GET /api/boq/:id/pdf
    if (rest[0] === 'pdf' && rest.length === 1 && method === 'GET') {
      const boq = boqStore.get(boqId);
      if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
      sendHtml(res, buildPdfHtml(boq));
      return;
    }

    // POST /api/boq/:id/push-hubspot
    if (rest[0] === 'push-hubspot' && rest.length === 1 && method === 'POST') {
      const boq = boqStore.get(boqId);
      if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
      try {
        const note        = await pushBoqToHubspot(boq);
        boq.hubspotNoteId = note.id;
        boq.updatedAt     = new Date().toISOString();
        boqStore.set(boq.id, boq);
        sendJson(res, 200, { success: true, noteId: note.id, boq });
      } catch (err) {
        sendJson(res, 502, { success: false, error: err.message });
      }
      return;
    }

    // POST /api/boq/:id/finalise
    if (rest[0] === 'finalise' && rest.length === 1 && method === 'POST') {
      const boq = boqStore.get(boqId);
      if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
      boq.status    = 'finalised';
      boq.updatedAt = new Date().toISOString();
      boqStore.set(boq.id, boq);
      sendJson(res, 200, { success: true, boq });
      return;
    }

    // POST /api/boq/:id/toggle-vat
    if (rest[0] === 'toggle-vat' && rest.length === 1 && method === 'POST') {
      const boq = boqStore.get(boqId);
      if (!boq) { sendJson(res, 404, { success: false, error: 'BOQ not found' }); return; }
      boq.includeVat = !boq.includeVat;
      const totals   = deriveTotals(boq.items, boq.includeVat);
      Object.assign(boq, totals, { updatedAt: new Date().toISOString() });
      boqStore.set(boq.id, boq);
      sendJson(res, 200, { success: true, includeVat: boq.includeVat, ...totals });
      return;
    }

    // No route matched
    sendJson(res, 404, { success: false, error: 'Route not found' });

  } catch (err) {
    console.error('BOQ API error:', err);
    sendJson(res, 500, { success: false, error: 'Internal server error' });
  }
}

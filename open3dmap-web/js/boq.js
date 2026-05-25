/**
 * BOQ (Bill of Quantities) Frontend Manager
 *
 * Handles all UI interactions for the BOQ page:
 *  - Creating / loading BOQs
 *  - Adding / editing / removing line items with live price calculation
 *  - HubSpot contact selector
 *  - VAT toggle
 *  - Finalise, PDF, push-to-HubSpot actions
 */

const API_BASE = '/api/boq';

// ---------------------------------------------------------------------------
// DOM element helpers
// ---------------------------------------------------------------------------

function el(id) { return document.getElementById(id); }

function setHtml(id, html) {
  const node = el(id);
  if (node) node.innerHTML = html;
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function showToast(message, type = 'info') {
  const container = el('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = {
  boq         : null,   // current BOQ document
  hubspotContacts: [],  // cached contact list
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export function init() {
  setupEventListeners();
  // If a BOQ id is in the URL hash, load it; otherwise show the create form
  const hashId = window.location.hash.replace('#', '');
  if (hashId) {
    loadBoq(hashId);
  } else {
    showSection('create-section');
  }
  loadHubspotContacts();
}

function setupEventListeners() {
  // Create BOQ form
  const createForm = el('create-boq-form');
  if (createForm) createForm.addEventListener('submit', onCreateBoq);

  // Add item button
  const addItemBtn = el('add-item-btn');
  if (addItemBtn) addItemBtn.addEventListener('click', onAddItem);

  // Finalise button
  const finaliseBtn = el('finalise-btn');
  if (finaliseBtn) finaliseBtn.addEventListener('click', onFinalise);

  // VAT toggle
  const vatToggle = el('vat-toggle');
  if (vatToggle) vatToggle.addEventListener('change', onToggleVat);

  // PDF button
  const pdfBtn = el('pdf-btn');
  if (pdfBtn) pdfBtn.addEventListener('click', onGeneratePdf);

  // HubSpot push button
  const hubspotBtn = el('push-hubspot-btn');
  if (hubspotBtn) hubspotBtn.addEventListener('click', onPushHubspot);

  // HubSpot contact selector change — populate client fields
  const contactSelect = el('hubspot-contact-select');
  if (contactSelect) contactSelect.addEventListener('change', onContactSelected);

  // Delegate item table events (edit / delete rows)
  const itemsTable = el('items-table');
  if (itemsTable) {
    itemsTable.addEventListener('input',  onItemInput);
    itemsTable.addEventListener('click',  onItemAction);
    itemsTable.addEventListener('change', onItemInput);
  }
}

// ---------------------------------------------------------------------------
// Section management
// ---------------------------------------------------------------------------

function showSection(id) {
  ['create-section', 'boq-section'].forEach(sid => {
    const s = el(sid);
    if (s) s.style.display = sid === id ? '' : 'none';
  });
}

// ---------------------------------------------------------------------------
// Create BOQ
// ---------------------------------------------------------------------------

async function onCreateBoq(evt) {
  evt.preventDefault();
  const form = evt.target;
  const payload = {
    title       : form.querySelector('[name="title"]')?.value.trim()       || 'Untitled BOQ',
    companyName : form.querySelector('[name="companyName"]')?.value.trim() || '',
    clientName  : form.querySelector('[name="clientName"]')?.value.trim()  || '',
    clientEmail : form.querySelector('[name="clientEmail"]')?.value.trim() || '',
    clientPhone : form.querySelector('[name="clientPhone"]')?.value.trim() || '',
    includeVat  : form.querySelector('[name="includeVat"]')?.checked ?? true,
  };

  try {
    const data = await apiFetch('/', { method: 'POST', body: payload });
    state.boq  = data.boq;
    window.location.hash = data.boq.id;
    renderBoq();
    showSection('boq-section');
    showToast('BOQ created successfully', 'success');
  } catch (err) {
    showToast(`Failed to create BOQ: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Load BOQ
// ---------------------------------------------------------------------------

async function loadBoq(id) {
  try {
    const data = await apiFetch(`/${id}`);
    state.boq  = data.boq;
    renderBoq();
    showSection('boq-section');
  } catch (err) {
    showToast(`Failed to load BOQ: ${err.message}`, 'error');
    showSection('create-section');
  }
}

// ---------------------------------------------------------------------------
// Render BOQ
// ---------------------------------------------------------------------------

function renderBoq() {
  const boq = state.boq;
  if (!boq) return;

  setText('boq-title',       boq.title);
  setText('boq-client',      boq.clientName  || '—');
  setText('boq-status-badge', boq.status);
  el('boq-status-badge')?.setAttribute('data-status', boq.status);

  const vatToggle = el('vat-toggle');
  if (vatToggle) vatToggle.checked = boq.includeVat;

  // Lock UI if finalised
  const isFinalised = boq.status === 'finalised';
  ['add-item-btn', 'finalise-btn', 'vat-toggle'].forEach(id => {
    const node = el(id);
    if (node) node.disabled = isFinalised;
  });

  renderItems(boq.items, isFinalised);
  renderTotals(boq);
}

function renderItems(items, readOnly) {
  const tbody = el('items-tbody');
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No items yet. Click "Add Item" to start.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map((item, idx) => `
    <tr data-item-id="${item.id}">
      <td class="row-num">${idx + 1}</td>
      <td><input class="item-field" name="description" value="${escHtml(item.description || '')}" ${readOnly ? 'readonly' : ''}></td>
      <td>
        <select class="item-field" name="pricingType" ${readOnly ? 'disabled' : ''}>
          <option value="per_piece" ${item.pricingType !== 'per_sqm' ? 'selected' : ''}>per piece</option>
          <option value="per_sqm"   ${item.pricingType === 'per_sqm' ? 'selected' : ''}>per m²</option>
        </select>
      </td>
      <td><input class="item-field num-field" name="qty"       type="number" min="0" step="0.01" value="${item.qty}"       ${readOnly ? 'readonly' : ''}></td>
      <td><input class="item-field num-field" name="unitPrice" type="number" min="0" step="0.01" value="${item.unitPrice}" ${readOnly ? 'readonly' : ''}></td>
      <td class="line-total num-cell">${fmt(item.lineTotal)}</td>
      <td>${readOnly ? '' : `<button class="btn-icon delete-item-btn" title="Remove" data-item-id="${item.id}"><i class="fas fa-trash"></i></button>`}</td>
    </tr>`).join('');
}

function renderTotals(boq) {
  setText('subtotal-cell',   fmt(boq.subTotal));
  setText('vat-cell',        fmt(boq.vatAmount));
  setText('grandtotal-cell', fmt(boq.grandTotal));

  const vatRow = el('vat-row');
  if (vatRow) vatRow.style.display = boq.includeVat ? '' : 'none';
}

function fmt(n) { return Number(n || 0).toFixed(2); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ---------------------------------------------------------------------------
// Item editing
// ---------------------------------------------------------------------------

/** Debounce timer per item row */
const debounceMap = {};

function onItemInput(evt) {
  const row    = evt.target.closest('tr[data-item-id]');
  if (!row) return;
  const itemId = row.dataset.itemId;

  // Optimistic client-side live total
  const descField  = row.querySelector('[name="description"]');
  const typeField  = row.querySelector('[name="pricingType"]');
  const qtyField   = row.querySelector('[name="qty"]');
  const priceField = row.querySelector('[name="unitPrice"]');

  const qty       = parseFloat(qtyField?.value)   || 0;
  const unitPrice = parseFloat(priceField?.value) || 0;
  const lineTotal = parseFloat((qty * unitPrice).toFixed(2));
  const totalCell = row.querySelector('.line-total');
  if (totalCell) totalCell.textContent = lineTotal.toFixed(2);

  // Debounce the API call
  clearTimeout(debounceMap[itemId]);
  debounceMap[itemId] = setTimeout(async () => {
    const body = {
      description : descField?.value  || '',
      pricingType : typeField?.value  || 'per_piece',
      qty,
      unitPrice,
    };
    try {
      const data = await apiFetch(`/${state.boq.id}/items/${itemId}`, { method: 'PUT', body });
      Object.assign(state.boq, data.totals);
      renderTotals(state.boq);
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    }
  }, 600);
}

function onItemAction(evt) {
  const btn = evt.target.closest('.delete-item-btn');
  if (!btn) return;
  const itemId = btn.dataset.itemId;
  if (itemId) removeItem(itemId);
}

async function onAddItem() {
  if (!state.boq) return;
  try {
    const data = await apiFetch(`/${state.boq.id}/items`, {
      method : 'POST',
      body   : { description: 'New item', qty: 1, unitPrice: 0, pricingType: 'per_piece' },
    });
    // Update local state
    state.boq.items.push(data.item);
    Object.assign(state.boq, data.totals);
    renderBoq();
  } catch (err) {
    showToast(`Failed to add item: ${err.message}`, 'error');
  }
}

async function removeItem(itemId) {
  if (!state.boq) return;
  try {
    const data = await apiFetch(`/${state.boq.id}/items/${itemId}`, { method: 'DELETE' });
    state.boq.items = state.boq.items.filter(i => i.id !== itemId);
    Object.assign(state.boq, data.totals);
    renderBoq();
    showToast('Item removed', 'info');
  } catch (err) {
    showToast(`Failed to remove item: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// VAT toggle
// ---------------------------------------------------------------------------

async function onToggleVat() {
  if (!state.boq) return;
  try {
    const data       = await apiFetch(`/${state.boq.id}/toggle-vat`, { method: 'POST' });
    state.boq.includeVat = data.includeVat;
    Object.assign(state.boq, { subTotal: data.subTotal, vatAmount: data.vatAmount, grandTotal: data.grandTotal });
    renderTotals(state.boq);
  } catch (err) {
    showToast(`VAT toggle failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Finalise
// ---------------------------------------------------------------------------

async function onFinalise() {
  if (!state.boq) return;
  if (!confirm('Finalise this BOQ? No further edits will be possible.')) return;
  try {
    const data = await apiFetch(`/${state.boq.id}/finalise`, { method: 'POST' });
    state.boq  = data.boq;
    renderBoq();
    showToast('BOQ finalised', 'success');
  } catch (err) {
    showToast(`Failed to finalise: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

function onGeneratePdf() {
  if (!state.boq) return;
  window.open(`${API_BASE}/${state.boq.id}/pdf`, '_blank');
}

// ---------------------------------------------------------------------------
// HubSpot integration
// ---------------------------------------------------------------------------

async function loadHubspotContacts() {
  try {
    const data = await apiFetch('/hubspot/contacts');
    state.hubspotContacts = data.contacts || [];
    populateContactSelect(state.hubspotContacts);
  } catch (err) {
    // HubSpot may not be configured — silently ignore
    console.info('HubSpot contacts unavailable:', err.message);
  }
}

function populateContactSelect(contacts) {
  const select = el('hubspot-contact-select');
  if (!select) return;
  select.innerHTML = `<option value="">— Select HubSpot contact —</option>` +
    contacts.map(c => `<option value="${c.id}" data-email="${escHtml(c.email)}" data-phone="${escHtml(c.phone)}">${escHtml(c.name)} (${escHtml(c.company || c.email)})</option>`).join('');
}

function onContactSelected(evt) {
  const option = evt.target.selectedOptions[0];
  if (!option || !option.value) return;

  const nameInput  = document.querySelector('[name="clientName"]');
  const emailInput = document.querySelector('[name="clientEmail"]');
  const phoneInput = document.querySelector('[name="clientPhone"]');

  // Pre-fill form fields from the selected contact
  if (nameInput)  nameInput.value  = option.textContent.split('(')[0].trim();
  if (emailInput) emailInput.value = option.dataset.email || '';
  if (phoneInput) phoneInput.value = option.dataset.phone || '';

  // If a BOQ is already active, update the hubspotContactId
  if (state.boq) {
    apiFetch(`/${state.boq.id}`, {
      method : 'PUT',
      body   : {
        hubspotContactId: option.value,
        clientName  : nameInput?.value  || '',
        clientEmail : emailInput?.value || '',
        clientPhone : phoneInput?.value || '',
      },
    }).then(data => { state.boq = data.boq; renderBoq(); })
      .catch(err => showToast(`CRM link failed: ${err.message}`, 'error'));
  }
}

async function onPushHubspot() {
  if (!state.boq) return;
  if (state.boq.status !== 'finalised') {
    showToast('Please finalise the BOQ before pushing to HubSpot', 'warning');
    return;
  }
  try {
    const data = await apiFetch(`/${state.boq.id}/push-hubspot`, { method: 'POST' });
    showToast(`BOQ pushed to HubSpot (note ID: ${data.noteId})`, 'success');
  } catch (err) {
    showToast(`HubSpot push failed: ${err.message}`, 'error');
  }
}

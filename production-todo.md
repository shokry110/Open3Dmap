# Production TODO — BOQ (Bill of Quantities) Generator

This file tracks the outstanding tasks for the BOQ module that integrates with HubSpot CRM.

---

## 1. BOQ Structure Development
- [x] Create flexible schema for BOQ (unlimited raw materials, unlimited service/condition columns)
- [x] Implement in-memory + Firestore-backed models for materials, services, and conditions
- [ ] Migrate BOQ schema to a production relational database (PostgreSQL) when scaling beyond Firebase

## 2. Material Calculation Logic
- [x] Backend logic to calculate cost: price per square metre **or** price per piece
- [x] Support dynamic line items sent from the frontend (quantity × unit price)
- [x] Sub-total, VAT (5%, configurable via `BOQ_VAT_RATE` env var), and grand-total derived automatically

## 3. PDF Generation
- [x] Server-side PDF endpoint (`GET /api/boq/:id/pdf`) using `jsPDF` / HTML-to-PDF
- [x] Header includes: company logo, company details, client name/contact, BOQ date
- [ ] Add digital signature / watermark support for finalised BOQs

## 4. HubSpot CRM Integration
- [x] `GET /api/boq/hubspot/contacts` – fetch contacts/deals from HubSpot
- [x] `POST /api/boq/:id/push-hubspot` – push finalised BOQ as a HubSpot note/deal
- [x] VAT toggle (add / remove 5%) reflected in CRM push
- [ ] OAuth 2.0 flow for multi-tenant HubSpot access (current: private-app token)

## 5. Frontend Integration
- [x] `boq.html` page with dynamic material table (add / remove rows)
- [x] Live calculation: sub-total, VAT, grand-total updated on every keystroke
- [x] HubSpot contact selector populated from CRM
- [x] "Generate PDF" button triggers server-side or client-side PDF export
- [x] BOQ status management (draft → finalised)
- [ ] Undo/redo history for line-item edits

## 6. Documentation & Commit
- [x] `production-todo.md` created (this file)
- [x] Staged on `develop` / feature branch
- [ ] Write CHANGELOG entry for BOQ feature release

## 7. Testing & Validation
- [ ] Unit tests for calculation helpers (`calculateLineItem`, `applyVAT`)
- [ ] Integration tests for HubSpot API mock (Jest + nock)
- [ ] End-to-end smoke test: create BOQ → add materials → generate PDF → push to HubSpot

## 8. Deployment
- [ ] Add `HUBSPOT_API_KEY` to Hetzner VM environment secrets
- [ ] Smoke-test BOQ endpoints in staging before merging to `main`
- [ ] Trigger Woodpecker CI pipeline (`git push origin main`) to auto-deploy to Hetzner VM

---

> **Next immediate steps:**
> 1. Set `HUBSPOT_API_KEY` in `.env` / deployment secrets.
> 2. Open `boq.html` in the browser and verify live calculations.
> 3. Run `node open3dmap-web/server.js` and call `GET /api/boq/hubspot/contacts`.

# Expense Tracker

A minimal full-stack personal finance app built for the assignment. It supports expense entry, filtering, date sorting, visible totals, idempotent submissions, an offline-first submit queue, receipt OCR fallback, smart anomaly alerts, and collaborative split tracking.

## Stack

- Next.js App Router for the frontend and API routes in one repository.
- Prisma with SQLite for local persistence.
- TanStack Query for retries, loading states, cache invalidation, and refresh-friendly UI state.
- Zod for request validation.
- Tailwind CSS with small shadcn-style UI primitives and lucide icons.
- Tesseract.js with local public English trained data for receipt OCR.

## Why SQLite

SQLite keeps local setup tiny and makes the data model explicit through Prisma. Money is stored as integer paise instead of floating point decimals, so totals and splits do not drift. For a hosted production version on Vercel, I would swap the datasource to a persistent hosted database such as Vercel Postgres, Neon, Turso, or PlanetScale because Vercel serverless file storage is not durable.

## Features

- Create expenses with amount, category, description, and date.
- Add and edit expenses through a modal form with React Hook Form + Zod validation.
- View expenses in a responsive table on desktop and card layout on mobile.
- Filter by category.
- Sort by date newest, date oldest, or amount high-to-low.
- See the total for the currently visible list.
- Idempotent `POST /expenses` and `POST /api/expenses` via `X-Idempotency-Key`.
- Offline-first expense queue: failed or offline submissions are stored in `localStorage` and synced later with the same idempotency key.
- Receipt upload flow at `POST /api/ocr` that runs Tesseract.js OCR, parses the recognized receipt text, and leaves the standard form editable when fields are uncertain.
- Smart alert when a new expense is at least 3x the category average after 3 existing category entries.
- Split an expense equally or by exact friend shares.
- Settlement summary and "mark settled" action for pending friend balances.
- Edit and delete actions for saved expenses.
- Visual category summary bars and CSV export for the visible list.

## Out-of-the-box features

- Offline-first queue for unreliable networks and refresh/retry scenarios.
- Receipt OCR autofill with manual fallback.
- Smart spending alerts for unusual category spikes.

## API

### `POST /expenses`

Also available at `POST /api/expenses`.

```json
{
  "amount": "249.50",
  "category": "Dining",
  "description": "Lunch",
  "date": "2026-04-29",
  "clientRequestId": "4fd63d4f-3951-4d3a-adcf-0b81e886f991",
  "split": {
    "mode": "equal",
    "friends": ["Asha", "Ben"]
  }
}
```

The frontend also sends `X-Idempotency-Key`. If the same request is retried with the same key, the API returns the original expense instead of creating a duplicate. If the same key is reused with a different payload, the API returns `409`.

### `GET /expenses`

Also available at `GET /api/expenses`.

Query params:

- `category=Dining`
- `sort=date_desc`
- `sort=date_asc`
- `sort=amount_desc`

### `PATCH /expenses/:id`

Also available at `PATCH /api/expenses/:id`. Updates amount, category, description, date, and split shares.

### `DELETE /expenses/:id`

Also available at `DELETE /api/expenses/:id`. Deletes an expense and its split shares.

### Settlement routes

- `GET /api/settlements`
- `POST /api/settlements/settle` with `{ "friendName": "Asha" }`

## Run locally

```bash
cp .env.example .env
npm install
npm run db:push
npm run dev
```

On PowerShell, use `Copy-Item .env.example .env` for the first command.

Open `http://localhost:3000`.

If Prisma's schema engine is blocked by a local Windows policy, run `npm run db:init` instead of `npm run db:push`; it creates the same SQLite tables from this repository's Prisma model.

## Test and build

```bash
npm test
npm run typecheck
npm run build
```

## Design decisions

- Amounts are parsed and stored as integer paise to avoid floating point errors.
- Dates are accepted as date-only strings and returned as `YYYY-MM-DD` to avoid timezone display drift.
- Idempotency is handled with a client-generated submission key stored in `localStorage` until the request succeeds. Offline queued expenses keep that same key, which protects against double clicks, browser refresh after submit, sync retries, and network retries.
- The OCR feature uses the public Tesseract.js OCR engine and local English trained data. The parser only fills amount/date when those values appear in recognized text; uncertain receipts fall back to manual correction.
- Split shares are modeled separately from expenses so settlement tracking can grow later without changing the expense table.

## Timebox trade-offs

- Authentication and multi-user ownership are intentionally out of scope.
- OCR runs locally with Tesseract.js rather than a paid hosted model such as Google Vision or AWS Textract.
- Settlement tracking records pending balances and can mark a friend's open shares as settled, but it does not keep a separate settlement ledger.
- Category management is a fixed dropdown plus categories already present in saved data rather than a dedicated settings screen.

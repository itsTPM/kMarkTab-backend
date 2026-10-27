# kMarkTab backend

A small proxy between the kMarkTab extension and Unsplash. It keeps the Unsplash key on
the server instead of in the extension, and caches responses so all users together stay
within the key's limit of 1000 requests per hour.

- **Curated collection**: every page of it is fetched every
  `CURATED_SYNC_MINUTES` and kept in memory and in `DATA_DIR/curated.json`. Serving it costs
  no Unsplash requests.
- **User's collection**: each deck is one `/photos/random?collections=<id>&count=30` request,
  so a photo added to the collection shows up in the next deck. Asked again within 5 minutes,
  the install gets the same deck from memory. That endpoint doesn't check the
  collection (a missing id gets photos from all of Unsplash, a private one its own photos), so
  a collection is first checked with `/collections/<id>` and trusted for 6 hours. Only public
  collections are supported.

The extension rotates through a deck on its own (on every tab, every minute…) and asks for the
next one when it runs low.

## Running

Node 24 runs the TypeScript sources directly, there is no build step.

```bash
cp .env.example .env   # set UNSPLASH_ACCESS_KEY and CURATED_COLLECTION_ID
pnpm install
pnpm dev               # restarts on changes
pnpm start
pnpm check             # typecheck + lint + format:check + test
```

## Deploying

CI builds the image and pushes it to `ghcr.io/itstpm/kmarktab-backend` on every green push to
`main`, tagged `latest` and with the commit SHA.

`compose.yml` runs that image behind [Caddy](https://caddyserver.com/), which gets a TLS
certificate for `DOMAIN` by itself. The app publishes no ports: only Caddy reaches it, so the
`X-Forwarded-For` it trusts can't be made up. The curated collection lives in the `data`
volume, so restarts and updates don't spend the budget on syncing it again.

The server needs Docker, the domain's DNS pointing to it, and three files from this repo:

```bash
ssh server mkdir -p kmarktab-backend
scp compose.yml Caddyfile .env.example server:kmarktab-backend/
```

Then, on the server, in `kmarktab-backend`:

```bash
cp .env.example .env   # set UNSPLASH_ACCESS_KEY, CURATED_COLLECTION_ID and DOMAIN
docker compose up -d
```

`PORT`, `DATA_DIR` and `TRUST_PROXY` from `.env` are overridden by `compose.yml`.

## API

All responses are JSON with `Cache-Control: no-store` and `Access-Control-Allow-Origin: *`.

|                           |                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/curated`         | 30 random photos of the curated collection                                                                             |
| `GET /v1/collections/:id` | 30 random photos of a public collection. Requires `X-Install-Id`: a random id the extension generates once per install |
| `GET /health`             | curated photo count, last sync, Unsplash budget estimate                                                               |

```jsonc
{
  "photos": [
    {
      "id": "abc123",
      "url": "https://images.unsplash.com/photo-…?ixid=…", // urls.raw: add w, q, fit…
      "width": 6000,
      "height": 4000,
      "color": "#a0b0c0",
      "blurHash": "LKO2?U%2Tw=w",
      "alt": "a mountain lake",
      "link": "https://unsplash.com/photos/abc123",
      "author": { "name": "Jane Doe", "link": "https://unsplash.com/@jane" },
    },
  ],
}
```

Errors are `{ "error": "<code>", "message": "…" }`:

| Status | `error`                                 |                                                                                                        |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 400    | `invalidCollection`, `invalidInstallId` |                                                                                                        |
| 404    | `collectionNotFound`                    | no such public collection (private ones count as missing), or it has no photos; remembered for an hour |
| 429    | `tooManyRequests`                       | `Retry-After` in seconds                                                                               |
| 503    | `curatedNotReady`                       | no curated photos yet: the first sync hasn't succeeded; `Retry-After`                                  |
| 503    | `budgetExhausted`                       | the Unsplash budget is used up for now; `Retry-After`                                                  |
| 502    | `upstream`                              | Unsplash failed                                                                                        |

On 429/503/502 the extension keeps rotating through the deck it has.

## Limits

**Unsplash budget** (`src/budget.ts`): one hourly budget, read from `X-Ratelimit-Remaining`
and `X-Ratelimit-Limit`. Each kind of request may spend only while more than its watermark, a
share of the limit, remains:

| Request                                        | Watermark | of 1000 (production) | of 50 (demo) |
| ---------------------------------------------- | --------- | -------------------- | ------------ |
| curated sync while there are no curated photos | 0         | 0                    | 0            |
| first deck of a collection for an install      | 5%        | 50                   | 2.5          |
| next decks                                     | 15%       | 150                  | 7.5          |
| scheduled curated sync                         | 30%       | 300                  | 15           |

**Clients** (`src/limits.ts`), in memory:

- 120 requests per minute per IP, any endpoint
- a new deck of the same collection once per 5 minutes per install; asked sooner, it gets
  the same deck again
- 48 decks per day per install
- 10 different collections per day per install
- 60 decks per hour per IP (install ids are made up by the client)

A deck counts as soon as it is asked for, so parallel requests see each other; a request
turned away by the budget or failed upstream is taken back. A deck served again doesn't count.

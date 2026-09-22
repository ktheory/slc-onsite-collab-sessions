# Breakout board

Scheduling board for the team on-site's breakout sessions. `SPEC.md` describes the
behavior; `prototype.html` is the original single-file artifact it was ported from.

## Layout

| Path | What |
| --- | --- |
| `shared/` | Roster, slots, wire protocol, clash detection. Used by both sides. |
| `backend/` | DynamoDB storage (`repo.ts`), message handling (`handler.ts`), the Lambda entry (`lambda.ts`) and a local WebSocket dev server. |
| `web/` | The page: Vite + TypeScript, no framework. `store.ts` reconciles optimistic edits with server pushes; `socket.ts` is the connection. |
| `infra/` | CDK stack: DynamoDB, API Gateway WebSocket API + Lambda, S3 + CloudFront, a Secrets Manager board key. |

## How it works

- **Live updates.** Each page holds a WebSocket to API Gateway. On connect it asks
  for a snapshot; after that, every change is acked to its sender and pushed to
  every other open page. Sessions carry a `version`, so late or out-of-order pushes
  are dropped.
- **Optimistic writes.** Edits show at once. While a session has an edit in flight,
  pushes for it update the server copy but don't overwrite what's on screen; when
  the edit settles, the card snaps to the server's version.
- **One change at a time.** API Gateway runs each message as a separate Lambda
  invocation, so the page sends the next change only after the last one is acked.
  That keeps "add Ahmad, remove Ahmad" in order.
- **Offline.** If the socket drops, changes queue, the page says how many are
  waiting, and they're sent on reconnect. Every operation is idempotent.
- **One session per person per slot is a soft rule.** The database allows a clash.
  Adding someone who's busy that slot is allowed with a warning: the roster marks
  where they already are, and adding them shows a heads-up. Moving a session still
  bumps anyone who'd clash (the server makes that call against fresh data). Any
  clash is flagged on the chips, in the summary and in the by-person grid.
- **Storage.** One table. Sessions are `pk=SESSIONS, sk=<id>` with `people` as a
  string set, so concurrent adds and removes are single atomic `ADD`/`DELETE`
  updates and never lose each other. Open connections are `pk=CONNS` with a TTL.
- **Access.** Anyone with the link can edit. The link carries a key in its
  `#fragment`; the WebSocket `$connect` route checks it against Secrets Manager.
  There's no per-person identity yet.

## Local development

```sh
npm install
npm run dev:db       # DynamoDB Local in Docker, port 8000
npm run dev:server   # WebSocket server on :8787, same handler as the Lambda
npm run dev:web      # http://localhost:5173
npm test             # needs dev:db running
```

## Deploy

Deploys to `us-east-2` (set `BOARD_REGION` to override). Needs AWS credentials.
Run these from the repo root; raw `cdk` commands need to run inside `infra/`.

```sh
npm run bootstrap    # once per account and region
npm run deploy       # builds web/, then cdk deploy
npm run link         # prints the shareable link, key included
```

The table is retained if the stack is deleted.

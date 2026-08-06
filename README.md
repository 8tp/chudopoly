# Chudopoly GO

An Air Force-themed, real-time multiplayer property card game for 2-5 players. It supports private room codes, five bot personalities, bot takeover after disconnects, turn and response timers, chat, and mobile layouts.

## Run locally

Requires Node.js 20-24.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. Use **Quick Play vs Bots** for a solo game or create a room and share its invite link.

## Configuration

Copy `.env.example` into your hosting provider's environment settings. `GIPHY_KEY` is optional. In production, same-origin WebSockets are accepted automatically; `ALLOWED_ORIGINS` adds explicitly trusted origins.

## Quality checks

```sh
npm run check
npm test
npm audit --audit-level=high
```

The game server is authoritative. Client commands are schema-validated and rate-limited, player reconnects require private resume tokens, and engine state is checked for duplicate or missing cards before broadcasts.

## Deployment notes

Rooms currently live in process memory. Run a single application instance unless room state is moved to shared storage. A restart or deploy ends active matches. `GET /health` provides a basic readiness response.

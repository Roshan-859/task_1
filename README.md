# Principle — real-time team room

Principle is a small, self-hostable video and collaboration app built for the Task 4 brief. It includes account creation and sign-in, invite-code rooms, multi-person video and audio, screen sharing, room chat, encrypted file sharing, and a shared drawing board.

## Run locally

Requirements: Node.js 20 or newer and npm.

```sh
npm install
cp .env.example .env
```

Edit `.env` and set `JWT_SECRET` to a unique random string of 32 or more characters. Then start the web app and API:

```sh
npm run dev
```

Open <http://localhost:5173>. Create an account, choose **Create a new room**, and share the room code or invite link. For a production-style local run, build the frontend with `npm run build` and start the API with `npm start` (serve the generated `dist/` directory from a TLS-enabled web server; see deployment notes).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | API and Socket.IO port (default `4000`) |
| `CLIENT_ORIGIN` | Exact frontend origin allowed by CORS (default `http://localhost:5173`) |
| `JWT_SECRET` | Secret used to sign 12-hour access tokens; required, never commit it |
| `DATA_DIR` | Location for the local account store (default `./data`) |
| `TURN_URLS` | Optional comma-separated TURN server URLs for restrictive networks |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | Credentials for the configured TURN service |

## How the features work

- **Video calls:** browser WebRTC peer connections with Socket.IO signaling. Calls use a mesh, suited to small rooms (up to eight people). STUN is configured by default.
- **Screen sharing:** browser screen capture is sent through the same peer connections.
- **File sharing:** files up to 8 MB are encrypted in the browser using AES-256-GCM, then relayed through the authenticated Socket.IO room. The file key is relayed with the ciphertext over the same protected connection; this is transport-protected sharing, not end-to-end encryption against the server operator.
- **Whiteboard and chat:** Socket.IO room events broadcast strokes and messages to connected members. Room activity is transient and clears when the last member leaves.
- **Authentication:** Express endpoints validate inputs, hash passwords with bcrypt, rate-limit auth attempts, and issue short-lived JWTs. Accounts are stored in a local JSON file with restrictive permissions; this is suitable for a demo or single-instance deployment, not a multi-instance production service.
- **Encryption:** browser WebRTC media uses DTLS-SRTP. Signaling and application traffic require HTTPS/WSS in deployment. Local development uses localhost. The whiteboard, chat, and signaling are protected in transit; they are not end-to-end encrypted from the server.

## Deployment and service setup

Deploy the API behind HTTPS and serve the built frontend from the same origin, or set `CLIENT_ORIGIN` to the exact HTTPS frontend URL and configure the frontend API/socket origin for your hosting arrangement. Put secrets in the hosting provider's environment settings. Do not publish `.env` or the `data/` directory.

STUN helps peers discover direct paths, but some corporate, mobile, or restrictive networks require a TURN relay. For reliable calls across those networks, provision a TURN service (for example, coturn or a hosted WebRTC provider), then set `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL`. The app does not include a TURN service or production credentials.

## Checks

```sh
npm run check
npm run build
```

The app needs a camera/microphone permission for media and a secure browser context (HTTPS, or localhost). Multi-user call quality depends on each participant's connection; mesh bandwidth grows with room size.

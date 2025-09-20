

# Zvonilka

A minimal peer-to-peer voice call app built with WebRTC and Vite.  
Runs directly in the **browser on desktop and mobile** — no installation required.  
Supports NAT traversal via TURN on TCP/443, works even in restricted networks.  

---

## Features
- One-click call link generation
- Works in modern browsers on **desktop and mobile**
- Progressive Web App (PWA) with offline page
- Multi-language UI (ru/en/he)
- Simple Node.js signaling server with WebSocket
- Dynamic TURN credentials (coturn REST API style)
- Lightweight and easy to deploy

---

## Project structure
```
├── index.html              # main entry with UI and PWA hooks
├── src/                    # application source code
│   ├── main.js             # bootstrap, i18n, button wiring
│   ├── js/                 # modules (webrtc, signaling, ui, helpers)
│   ├── utils/              # env/url/logger utilities
│   └── webrtc/peer.js      # future stubs for peer logic
├── public/                 # static assets (served as root)
│   ├── i18n/*.json         # translations
│   ├── icons/*             # PWA icons
│   ├── manifest.webmanifest
│   └── offline.html
├── server.js               # signaling server + TURN creds
├── sw.js                   # service worker
├── vite.config.js          # Vite config (dev+build+proxy)
├── ecosystem.config.cjs    # PM2 config for production
└── ...
```

---

## Installation
Requirements: **Node.js 20+** and **npm**.

```bash
git clone https://github.com/your-org/zvonilka.git
cd zvonilka
npm install
```

---

## Development
Run dev server with Vite + proxy to local signaling server:

```bash
# Start signaling server (port 3000)
npm run start

# In another terminal: Vite dev server (port 5173)
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

---

## Build
```bash
npm run build
npm run preview   # serve dist/ locally
```

---

## Testing
We use **Vitest** and **Playwright**.

```bash
# Lint
npm run lint

# Unit + integration tests
npm run test:unit

# End-to-end tests (requires preview server)
npm run e2e
```

CI runs lint + tests on every push.

---

## Deployment

### PM2
For production on Node.js host:
```bash
pm2 start ecosystem.config.cjs
```

### Nginx
Proxy `/signal` and `/ws` to Node.js backend on port 3000.  
Static frontend can be served by Nginx directly from `/dist`.

---

## Configuration
Environment variables for `server.js`:
- `TURN_SECRET` – coturn static-auth-secret
- `TURN_URLS` – comma-separated TURN server URIs
- `TURN_TTL` – credential TTL in seconds (default 120)
- `PORT` – signaling server port (default 3000)

---

## License
MIT (or your chosen license)

---

## Notes for maintainers
- Keep translations consistent across `ru.json`, `en.json`, `he.json`.
- Always run `npm run lint && npm run test` before committing.
- `readme.AI` contains AI collaboration rules; not part of production docs.
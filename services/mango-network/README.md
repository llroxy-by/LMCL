# Mango Network backend skeleton

A dependency-free Node.js service-domain skeleton. It deliberately provides no SMTP client, database driver, `.env` loader, or auto-starting/public HTTP listener.

## Included

- Explicit configuration validation; loopback host only.
- Registration state machine (`pending_email_verification` → `active`). Verification codes and opaque session tokens are stored only as peppered SHA-256 hashes.
- Password storage with Node `crypto.scrypt` and per-password random salt.
- Login plus short-lived access and rotating refresh sessions. Reuse of a rotated refresh token revokes its entire token family.
- In-memory user, session, cloud-save metadata, and immutable snapshot repositories.
- Cloud snapshots use `expectedVersion` optimistic concurrency.

## Use

```js
import { loadConfig, MangoService } from './src/index.mjs';

const config = loadConfig(runtimeValues); // pass values explicitly; never reads process.env
const service = new MangoService({
  config,
  verificationDelivery: async ({ to, code, expiresAt }) => {
    // Test adapter or application-owned delivery queue. No SMTP is included.
  }
});
```

The delivery callback receives the one-time plaintext code; repository records never do. The callback should avoid logging it in production. Returned cloud snapshot `data` is a copied `Buffer`.

Run tests with `npm test` from this directory, or `node --test services/mango-network/test/*.test.mjs` from the repository root.

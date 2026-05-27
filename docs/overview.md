# ProxyCloud – Overview

## Purpose

ProxyCloud is a **transparent encrypted proxy** that acts as the bridge between external clients (browsers, desktop apps) and a CloudServer instance. It provides:

- **Protocol forwarding** — routes encrypted messages between clients and the cloud server without the proxy ever seeing the plaintext.
- **QR code pairing** — serves a partial QR code payload (`GetEncryptedQR`) so that initial device pairing can use a shorter, hybrid QR/proxy flow.
- **Push notification relay** — allows clients to poll for push messages sent by the device via `GetPushNotifications`.
- **Client public key exchange** — the `SetClient` purpose delivers the client's public key to the server for the first-time handshake.

## Solution Structure

| Project | Role |
|---|---|
| `ProxyCloud` | ASP.NET Core host (entry point, `Startup`, HTTP endpoints) |
| `ProxyAPISupport` | Reusable library: `Communication`, `CommunicationServer`, `MapEndpoints`, `PairedTable`, `Util` |

## Architecture

```
External Client (browser / app)
		│  HTTPS (port 443 / 5050)
		▼
ProxyCloud (ASP.NET Core)
  ├─ GET  /           → status page
  ├─ GET  /data       → poll / download forwarded data
  └─ POST /data       → upload / forward data to cloud server
		│  EncryptedMessaging (RouterServer TCP / named pipe)
		▼
RouterServer ──► CloudServer
```

All payload bytes are ciphertext — the proxy relays them without decryption. The proxy's role is purely transport.

## Key Concepts

- **`Communication.Purpose`** — discriminated union of message purposes: `Forwarding`, `ForwardingWithEncryptRsa256`, `GetProxyAddress`, `GetPushNotifications`, `SetClient`, `GetEncryptedQR`.
- **`PairedTable`** — persistent lookup table mapping `ClientId` ↔ `ChatId` (used for session association).
- **`CommunicationServer`** — manages the EncryptedMessaging context that connects to RouterServer.
- **AppSync integration** — the proxy hosts a static file repository (`WebRepository`) for app update distribution.

## Repository

GitHub: [https://github.com/Andrea-Bruno/ProxyCloud](https://github.com/Andrea-Bruno/ProxyCloud)

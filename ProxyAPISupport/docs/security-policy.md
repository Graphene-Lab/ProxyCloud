# ProxyAPISupport – Security Policy

## Zero-Knowledge Proxy

The proxy operates on a **zero-knowledge** principle: it routes encrypted messages but cannot read their content. The encryption is performed end-to-end between the client and the cloud server, using keys that the proxy never possesses.

The `SetClient` purpose is the **only unencrypted operation** — it carries only a public key, which by nature is not secret.

## Proxy Identity Key

The proxy uses an `EncryptedMessaging` secp256k1 private key for its own identity on the network. Cloud servers whitelist the corresponding **public key** (`ProxyPublicKey` in `appsettings.json`). Only the whitelisted proxy can forward messages to a given server.

| Risk | Mitigation |
|---|---|
| Proxy key compromise | Attacker could impersonate the proxy to cloud servers — rotate `ProxyPublicKey` on all servers and issue a new key |
| Key hard-coded in config | Use environment variables or a secrets manager in production |

## Log Endpoint Security

The `GET /data?log=...&scope=...` endpoint writes to disk. The `scope` parameter is validated with `Regex.IsMatch(scope, @"^[a-zA-Z0-9_]+$")` to prevent directory traversal. Do not relax this validation.

## GitHub-Sourced QR Client

The `?qr` endpoint fetches `CryptoCloudClientWeb.html` from GitHub at request time using `WebClient`. Risks:

- GitHub availability dependency.
- Content served may change without notice (GitHub commit history provides auditability).

For production hardening, cache a local copy of the HTML file instead of fetching from GitHub.

## HTTPS Requirement

The proxy must be deployed behind HTTPS. All client communications include sensitive cryptographic material that must not be exposed in plaintext.

## DDoS Considerations

The `/data` POST endpoint is the primary attack surface. Rate limiting should be applied at the reverse proxy (nginx/Caddy) or WAF level in front of ProxyAPISupport.

## Reporting Vulnerabilities

Open a private GitHub Security Advisory in the repository. Do not disclose vulnerabilities publicly before a fix is available.

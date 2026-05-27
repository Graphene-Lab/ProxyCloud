# ProxyCloud – Security Policy

## Zero-Knowledge Forwarding

The proxy's fundamental security property: **it never decrypts data**. All payloads forwarded via `/data` are encrypted end-to-end between client and CloudServer. Compromising the proxy does not expose message content or file data.

## Proxy Private Key

`PrivateKey` in `appsettings.json` is the proxy's identity on the EncryptedMessaging network. If this key is compromised:

- An attacker can impersonate the proxy on the router network.
- CloudServer instances that trust the corresponding public key will accept connections from the attacker.
- **Rotate immediately**: generate a new key pair, update `PrivateKey` in the proxy config and `ProxyPubKey` in every CloudServer config.

Never commit `PrivateKey` to source control. Use environment variables or a secrets manager in production.

## HTTPS

The proxy must be deployed behind a TLS-terminating reverse proxy (nginx, Caddy, Traefik) in production. The raw HTTP endpoint on port 5050 must not be exposed to the internet.

## CORS Policy

The current CORS configuration is permissive (`AllowAnyOrigin`, `AllowAnyMethod`, `AllowAnyHeader`). This is intentional because the proxy serves browser clients from arbitrary origins (the CloudBox pairing flow). If your deployment context restricts client origins, tighten the CORS policy to a known allowlist.

## Static Files and Update Uploads

`AppSync.WebRepository` serves static files from `wwwroot` and optionally allows update uploads. Control upload access via `IpsEnabledToUploadUpdates` — set it to the exact IP(s) of your build/release servers only. An empty value disables all uploads.

## Log File Security

Request logs written to `<WebRootPath>/logs/` may contain IP addresses and request metadata. Ensure:

- The `logs/` directory is not served as a static file (add an exclusion or move it outside `wwwroot`).
- Log files are rotated and not retained longer than necessary under your data retention policy.

## Debug vs Release Keys

`Startup.cs` contains hardcoded debug key pairs used in `DEBUG` builds. These are **not secret** (they are default development keys). Confirm that production deployments use `RELEASE` or a custom configuration that reads keys from `appsettings.json` or environment variables — never the hardcoded debug keys.

## Reporting Vulnerabilities

Open a private GitHub Security Advisory in the repository. Do not disclose vulnerabilities publicly before a fix is available.

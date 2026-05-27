# ProxyAPISupport – System Overview

## Purpose

ProxyAPISupport is an **ASP.NET Core library** (.NET 9) that provides an **encrypted HTTP/HTTPS proxy bridge** between external clients (browsers, mobile apps) and CloudBox servers. It enables client devices and web browsers to communicate with cloud servers through a public-facing HTTPS proxy, while ensuring that the proxy itself **cannot read the transmitted data** (encrypted end-to-end).

## Role in the Architecture

```
Browser / Mobile App
		│
		│ HTTPS
		▼
ProxyAPISupport (public-facing, internet)
		│
		│ EncryptedMessaging protocol
		▼
RouterServer
		│
		▼
CloudServer (private, behind router)
```

The proxy acts as a **transparent relay**: it receives data from clients, forwards it to the destination cloud server via the router, and returns the response. All payloads are encrypted by the client before transmission and can only be decrypted by the target server.

## Communication Purposes

The `Communication.Purpose` enum defines the types of messages the proxy handles:

| Purpose | Description |
|---|---|
| `Forwarding` | Generic forwarded data (encrypted) |
| `ForwardingWithEncryptRsa256` | Forwarded data with RSA-256 envelope |
| `GetProxyAddress` | Client queries the proxy's own address |
| `GetPushNotifications` | Browser/client polls for push messages from device |
| `SetClient` | Client sends its public key for initial key exchange (unencrypted, pre-handshake) |
| `GetEncryptedQR` | Retrieves the second part of a split QR code (Type 2 QR) |

## HTTP Endpoints (MapEndpoints.cs)

| Endpoint | Method | Purpose |
|---|---|---|
| `/proxyinfo` | GET | Status, ping (`?ping`), QR browser client (`?qr`), proxy info |
| `/data` | GET | Log retrieval, push notification polling |
| `/data` | POST | Forward data from client to cloud server |

## Paired Table

`PairedTable.cs` maintains a mapping between clients and their associated cloud server instances, enabling the proxy to route responses back to the correct client.

## Local Entry Point Modes

```csharp
public enum LocalEntryPoint
{
	Pipe,           // Named pipe (in-process, same machine as router)
	LocalhostHttp,  // HTTP loopback (router on same host)
	LocalhostTcp    // TCP loopback
}
```

## Dependencies

- `EncryptedMessaging`
- `RouterServer` (via Named Pipe or TCP loopback)
- `CommunicationChannel`

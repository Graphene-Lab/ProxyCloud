Run from the ProxyCloud repository:

```powershell
node --test --test-reporter=spec ClientHtml/tests/zero-knowledge-file-operations.test.cjs
```

Requires Node.js and the `playwright` package available through `node_modules` or `NODE_PATH`. On Windows the suite uses installed Microsoft Edge. Elsewhere it uses Playwright Chromium. Set `PLAYWRIGHT_EXECUTABLE_PATH` to select another Chromium browser executable. These are test dependencies only; the HTML client remains a standalone file.

The tests load the actual HTML in fresh browser contexts and exercise its rendered file cards, toolbar buttons, prompts, and destination confirmation. XHR is mocked and its packets are inspected; fetch, beacon, WebSocket, service workers, and other browser requests cannot access a real server. Only synthetic files and test passphrases are used. Transport encryption is replaced with an identity function inside each test context so command IDs and payloads can be asserted; path/content encryption code is unchanged.

Coverage includes enabled/disabled mode, available/missing keys, restored sessions, files/folders/mixed selections, and mode changes during destination selection. The temporary restriction only disables controls; direct JavaScript calls and queued/in-flight requests are not blocked. A test confirms the operation and request paths remain unchanged. Browsing, upload/download requests, deletion, folder creation, and favorites are also exercised. This does not validate a real server or end-to-end file transfer.

Optional: set `TEST_SCREENSHOT_PATH` to an absolute PNG path to capture the restricted toolbar during the allowed-operations test.

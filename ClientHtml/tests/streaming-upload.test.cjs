const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const html = readFileSync(path.join(__dirname, '..', 'CryptoCloudClientWeb.html'), 'utf8');
const UPLOAD_CHUNK_SIZE = 1 * 1024 * 1024;
const ZK_PASSPHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FILE_TIMESTAMP = 1700000000;
const FILE_TIMESTAMP_MS = FILE_TIMESTAMP * 1000;
let browser;

before(async () => {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
            : process.platform === 'win32' ? { channel: 'msedge' } : {}),
    });
});
after(async () => { await browser?.close(); });

async function openClient(t) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(5000);
    const errors = [];
    const unexpectedNetwork = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        if (route.request().isNavigationRequest() && route.request().url() === 'https://web-client.test/') {
            return route.fulfill({ contentType: 'text/html', body: html });
        }
        unexpectedNetwork.push(route.request().url());
        return route.abort();
    });
    await context.addInitScript(() => {
        localStorage.clear();
        window.testRequests = [];
        window.testSetFileRequests = [];
        window.testUnexpectedNetwork = [];
        window.testAutoAck = true;
        window.testHoldAcks = false;
        window.testRespond507 = false;
        window.testFailSetFile = false;
        window.testPendingSetFile = null;

        window.fetch = async url => {
            window.testUnexpectedNetwork.push(String(url));
            throw new Error('Unexpected fetch: network is disabled in this test');
        };
        navigator.sendBeacon = url => {
            window.testUnexpectedNetwork.push(String(url));
            return false;
        };

        function makeSetFileResponse(fullName, chunkPart) {
            const text = chunkPart === undefined ? fullName : fullName + '\t' + chunkPart;
            const payload = new TextEncoder().encode(text);
            const response = new Uint8Array(8 + payload.byteLength);
            const view = new DataView(response.buffer);
            view.setInt32(0, command.SetFile, true);
            view.setUint32(4, payload.byteLength, true);
            response.set(payload, 8);
            return btoa(String.fromCharCode.apply(null, response));
        }

        window.XMLHttpRequest = class {
            constructor() {
                this.status = 0;
                this.readyState = 0;
                this.DONE = 4;
                this.responseText = '';
                this.upload = { onprogress: null };
            }
            open(method, url) {
                this.method = method;
                this.url = url;
            }
            abort() {
                this.aborted = true;
                if (this.onabort) {
                    this.onabort.call(this);
                }
            }
            send(data) {
                const bytes = data || new ArrayBuffer(0);
                const commandId = bytes.byteLength >= 4 ? bufferToInt(bytes.slice(0, 4)) : null;
                const payload = bytes.byteLength >= 4 ? bufferToString(bytes.slice(4)) : '';
                window.testRequests.push({ command: commandId, payloadLength: bytes.byteLength });

                if (commandId !== command.SetFile) {
                    return;
                }

                const json = JSON.parse(payload);
                const request = {
                    fullName: json.FullName,
                    chunkPart: json.ChunkPart,
                    totalChunk: json.TotalChunk,
                    data: json.Data,
                };
                window.testSetFileRequests.push(request);
                if (this.upload.onprogress) {
                    this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
                }
                const respond = () => {
                    this.responseText = window.testRespond507
                        ? makeSetFileResponse('507')
                        : makeSetFileResponse(json.FullName, json.ChunkPart);
                    this.status = 200;
                    this.readyState = this.DONE = 4;
                    if (this.onload) {
                        this.onload.call(this);
                    }
                };
                if (window.testFailSetFile) {
                    queueMicrotask(() => {
                        this.status = 0;
                        this.readyState = this.DONE = 4;
                        if (this.onerror) {
                            this.onerror.call(this);
                        }
                    });
                    return;
                }
                if (window.testHoldAcks) {
                    window.testPendingSetFile = { request: this, respond: respond };
                    return;
                }
                queueMicrotask(respond);
            }
        };

        window.releaseSetFileAck = function () {
            const pending = window.testPendingSetFile;
            window.testPendingSetFile = null;
            if (pending) {
                pending.respond();
            }
        };

        HTMLMediaElement.prototype.play = async () => {};
    });
    t.after(async () => {
        try {
            assert.deepEqual(errors, [], 'No browser script errors');
            assert.deepEqual(unexpectedNetwork, [], 'No unmocked browser requests');
            assert.deepEqual(await page.evaluate(() => window.testUnexpectedNetwork), [], 'No unmocked fetch/beacon');
        } finally {
            await context.close();
        }
    });
    await page.goto('https://web-client.test/');
    await page.waitForFunction(() => session.clientId != null);
    await page.evaluate(() => {
        session.deviceKey = 'test-only-transport-key';
        proxy = 'https://mock-cloud.invalid';
        encryptDataForTheDevice = async data => data;
        decryptDataFromTheDevice = async data => data;
    });
    return page;
}

async function prepareUpload(page, { name = 'stream.bin', size = UPLOAD_CHUNK_SIZE + 37, zk = false, holdAcks = false, failRead = false } = {}) {
    await page.evaluate(async ({ name, size, zk, holdAcks, failRead, passphrase, timestamp }) => {
        if (zk) {
            zeroKnowledgeEnabled = true;
            setZeroKnowledgePassphrase(passphrase);
            await initializeZeroKnowledgeState();
        }
        currentPath = 'source';
        const bytes = new Uint8Array(size);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = (i * 31 + 7) & 255;
        }
        window.testSourceBytes = bytes;
        window.testClearName = 'source/' + name;
        window.testTimestamp = timestamp;
        window.testHoldAcks = holdAcks;
        window.testAutoAck = !holdAcks;
        window.testStages = [];
        window.testSliceSizes = [];
        window.testPendingSetFile = null;
        const originalSlice = Blob.prototype.slice;
        Blob.prototype.slice = function (start, end, type) {
            if (this instanceof File) {
                window.testSliceSizes.push((end == null ? this.size : end) - (start || 0));
            }
            return originalSlice.call(this, start, end, type);
        };
        window.testBadgeVisible = !document.getElementById('zkModeBadge').hidden;
        const observer = new MutationObserver(() => {
            const text = document.getElementById('topBar').innerText;
            if (!window.testStages.includes(text)) {
                window.testStages.push(text);
            }
        });
        observer.observe(document.getElementById('topBar'), { childList: true, subtree: true, characterData: true, attributes: true });
        window.testObserver = observer;
        if (failRead) {
            Blob.prototype.arrayBuffer = function () {
                return Promise.reject(new Error('synthetic read failure'));
            };
        }
        const file = new File([bytes], name, { lastModified: timestamp * 1000 });
        window.testFile = file;
        window.testUploadStarted = performance.now();
        startSendFile(file, false);
    }, { name, size, zk, holdAcks, failRead, passphrase: ZK_PASSPHRASE, timestamp: FILE_TIMESTAMP });
}

async function waitForUpload(page, totalChunks) {
    await page.waitForFunction(({ totalChunks }) => {
        const active = Object.keys(uploadSessions).filter(key => uploadSessions[key]);
        return window.testSetFileRequests.length >= totalChunks && active.length === 0;
    }, { totalChunks });
}

async function uploadSummary(page, zk) {
    return page.evaluate(async (zk) => {
        const chunks = window.testSetFileRequests.slice().sort((a, b) => a.chunkPart - b.chunkPart);
        let byteLength = 0;
        for (const chunk of chunks) {
            byteLength += base64ToBuffer(chunk.data).byteLength;
        }
        const uploaded = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
            const bytes = new Uint8Array(base64ToBuffer(chunk.data));
            uploaded.set(bytes, offset);
            offset += bytes.byteLength;
        }

        const source = window.testSourceBytes;
        let expected = source;
        if (zk) {
            const state = getZeroKnowledgeState();
            const key = deriveContentKeyFromClearPath(window.testClearName, window.testTimestamp, state);
            expected = new Uint8Array(cryptFileBytes(source, key));
        }
        const sourceHash = bufferToHex(await hash256(source));
        const expectedHash = bufferToHex(await hash256(expected));
        const uploadedHash = bufferToHex(await hash256(uploaded));
        window.testObserver?.disconnect();
        return {
            chunks: chunks.map(chunk => ({ chunkPart: chunk.chunkPart, totalChunk: chunk.totalChunk, bytes: base64ToBuffer(chunk.data).byteLength })),
            expectedHash,
            uploadedHash,
            sourceHash,
            fullName: chunks.length ? chunks[0].fullName : null,
            stages: window.testStages.slice(),
            sliceSizes: window.testSliceSizes.slice(),
            badgeVisible: window.testBadgeVisible,
        };
    }, zk);
}

test('chunked cipher output is byte-identical to whole-file output', async t => {
    const page = await openClient(t);
    const result = await page.evaluate(async () => {
        const key = Uint8Array.from({ length: 64 }, (_, i) => i);
        const source = Uint8Array.from({ length: 65537 }, (_, i) => (i * 31 + 7) & 255);
        const whole = new Uint8Array(cryptFileBytes(source, key));
        const sizes = [];
        let remaining = source.byteLength;
        let i = 1;
        while (remaining > 0) {
            const size = Math.min(remaining, (i * 13) % 257 + 1);
            sizes.push(size);
            remaining -= size;
            i++;
        }
        const state = createCipherState(key);
        let offset = 0;
        const chunks = [];
        for (const size of sizes) {
            chunks.push(new Uint8Array(cryptChunk(source.subarray(offset, offset + size), state)));
            offset += size;
        }
        const chunked = new Uint8Array(source.byteLength);
        offset = 0;
        for (const chunk of chunks) {
            chunked.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return {
            same: bufferToHex(await hash256(whole)) === bufferToHex(await hash256(chunked)),
            hash: bufferToHex(await hash256(whole)),
            stateOffset: state.offset,
        };
    });
    assert.equal(result.same, true);
    assert.equal(result.stateOffset, 65537);
    assert.equal(result.hash, '7de64508f6625b15c7acb2a1d8ca69aabd6066d33541785a7bedab8bd49689b3');
});

test('empty file upload still sends one valid chunk', async t => {
    const page = await openClient(t);
    await prepareUpload(page, { name: 'empty.bin', size: 0 });
    await waitForUpload(page, 1);
    const summary = await uploadSummary(page, false);
    assert.deepEqual(summary.chunks, [{ chunkPart: 1, totalChunk: 1, bytes: 0 }]);
    assert.equal(summary.uploadedHash, summary.sourceHash);
});

test('non-ZK upload streams 1 MB chunks and keeps only chunk-sized reads', async t => {
    const page = await openClient(t);
    await prepareUpload(page, { size: UPLOAD_CHUNK_SIZE + 37 });
    await waitForUpload(page, 2);
    const summary = await uploadSummary(page, false);
    assert.equal(summary.chunks.length, 2);
    assert.deepEqual(summary.chunks.map(chunk => chunk.bytes), [UPLOAD_CHUNK_SIZE, 37]);
    assert.deepEqual(summary.chunks.map(chunk => chunk.chunkPart), [1, 2]);
    assert.equal(summary.chunks[0].totalChunk, 2);
    assert.equal(summary.uploadedHash, summary.sourceHash);
    assert.equal(summary.expectedHash, summary.sourceHash);
    assert.equal(summary.badgeVisible, false);
    assert.equal(summary.fullName, 'source/stream.bin');
    assert.ok(summary.sliceSizes.every(size => size <= UPLOAD_CHUNK_SIZE));
    assert.ok(summary.stages.some(stage => stage.includes('reading')));
    assert.ok(summary.stages.some(stage => stage.includes('sending 50%')));
    assert.ok(!summary.stages.some(stage => stage.includes('encrypting')));
});

test('ZK upload streams ciphertext that decrypts to the source', async t => {
    const page = await openClient(t);
    await prepareUpload(page, { size: UPLOAD_CHUNK_SIZE + 37, zk: true });
    await waitForUpload(page, 2);
    const summary = await uploadSummary(page, true);
    assert.equal(summary.chunks.length, 2);
    assert.deepEqual(summary.chunks.map(chunk => chunk.bytes), [UPLOAD_CHUNK_SIZE, 37]);
    assert.equal(summary.uploadedHash, summary.expectedHash);
    assert.equal(summary.badgeVisible, true);
    assert.notEqual(summary.fullName, 'source/stream.bin');
    assert.ok(summary.stages.some(stage => stage.includes('reading')));
    assert.ok(summary.stages.some(stage => stage.includes('encrypting')));
    assert.ok(summary.stages.some(stage => stage.includes('sending')));

    const same = await page.evaluate(async () => {
        const chunks = window.testSetFileRequests.slice().sort((a, b) => a.chunkPart - b.chunkPart);
        let total = 0;
        for (const chunk of chunks) total += base64ToBuffer(chunk.data).byteLength;
        const encrypted = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            const bytes = new Uint8Array(base64ToBuffer(chunk.data));
            encrypted.set(bytes, offset);
            offset += bytes.byteLength;
        }
        const key = deriveContentKeyFromClearPath(window.testClearName, window.testTimestamp, getZeroKnowledgeState());
        const decrypted = new Uint8Array(cryptFileBytes(encrypted, key));
        return bufferToHex(await hash256(decrypted)) === bufferToHex(await hash256(window.testSourceBytes));
    });
    assert.equal(same, true);
});

test('upload waits for the previous chunk acknowledgment before reading the next chunk', async t => {
    const page = await openClient(t);
    await prepareUpload(page, { size: UPLOAD_CHUNK_SIZE + 37, holdAcks: true });
    await page.waitForFunction(() => window.testSetFileRequests.length === 1);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.testSetFileRequests.length), 1);
    assert.deepEqual(await page.evaluate(() => window.testSliceSizes), [UPLOAD_CHUNK_SIZE]);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.cancelUpload').length), 1);
    assert.equal(await page.evaluate(() => {
        const session = Object.values(uploadSessions).find(Boolean);
        return !!session && ('data' in session || 'buffer' in session);
    }), false);

    await page.evaluate(() => {
        window.testHoldAcks = false;
        window.testAutoAck = true;
        window.releaseSetFileAck();
    });
    await waitForUpload(page, 2);
    const summary = await uploadSummary(page, false);
    assert.deepEqual(summary.chunks.map(chunk => chunk.bytes), [UPLOAD_CHUNK_SIZE, 37]);
});

test('507 removes upload state and progress instead of leaving a stuck bar', async t => {
    const page = await openClient(t);
    await page.evaluate(() => { window.testRespond507 = true; });
    await prepareUpload(page, { name: 'no-space.bin', size: 1024 });
    await page.waitForFunction(() => {
        const active = Object.keys(uploadSessions).filter(key => uploadSessions[key]);
        return window.testSetFileRequests.length === 1 && active.length === 0;
    });
    const state = await page.evaluate(() => ({
        active: Object.keys(uploadSessions).filter(key => uploadSessions[key]).length,
        bars: document.querySelectorAll('#topBar progress').length,
        alert: document.getElementById('alertBox').innerText,
    }));
    assert.equal(state.active, 0);
    assert.equal(state.bars, 0);
    assert.match(state.alert, /no space/i);
});

test('cancel aborts the in-flight upload and removes its progress bar', async t => {
    const page = await openClient(t);
    await prepareUpload(page, { name: 'cancel.bin', size: 1024, holdAcks: true });
    await page.waitForFunction(() => window.testSetFileRequests.length === 1);
    await page.locator('.cancelUpload').click();
    await page.waitForFunction(() => {
        const active = Object.keys(uploadSessions).filter(key => uploadSessions[key]);
        return active.length === 0 && document.querySelectorAll('.cancelUpload').length === 0;
    });
    assert.equal(await page.evaluate(() => window.testPendingSetFile?.request?.aborted), true);
    assert.match(await page.locator('#alertBox').innerText(), /canceled/i);
});

test('file read failure removes the upload progress and reports the read error', async t => {
    const page = await openClient(t);
    await prepareUpload(page, { name: 'read-failure.bin', size: 1024, failRead: true });
    await page.waitForFunction(() => {
        const active = Object.keys(uploadSessions).filter(key => uploadSessions[key]);
        return active.length === 0 && document.getElementById('alertBox').innerText.includes('reading');
    });
    assert.equal(await page.evaluate(() => document.querySelectorAll('#topBar progress').length), 0);
    assert.match(await page.locator('#alertBox').innerText(), /synthetic read failure/);
});

test('transport failure removes the upload progress and does not retry', async t => {
    const page = await openClient(t);
    await page.evaluate(() => { window.testFailSetFile = true; });
    await prepareUpload(page, { name: 'failure.bin', size: 1024 });
    await page.waitForFunction(() => {
        const active = Object.keys(uploadSessions).filter(key => uploadSessions[key]);
        return window.testSetFileRequests.length === 1 && active.length === 0;
    });
    assert.equal(await page.evaluate(() => window.testSetFileRequests.length), 1);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#topBar progress').length), 0);
    assert.match(await page.locator('#alertBox').innerText(), /No automatic retry/i);
});

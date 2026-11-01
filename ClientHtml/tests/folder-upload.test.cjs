const assert = require('node:assert/strict');
const {
    readFileSync,
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const htmlPath = path.join(__dirname, '..', 'CryptoCloudClientWeb.html');
const html = readFileSync(htmlPath, 'utf8');
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

async function openClient(t, { localFile = false } = {}) {
    const clientUrl = localFile ? pathToFileURL(htmlPath).href : 'https://web-client.test/';
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(5000);
    const errors = [];
    const unexpectedNetwork = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        if (route.request().isNavigationRequest() && route.request().url() === clientUrl) {
            return localFile ? route.continue() : route.fulfill({ contentType: 'text/html', body: html });
        }
        unexpectedNetwork.push(route.request().url());
        return route.abort();
    });
    await context.addInitScript(() => {
        localStorage.clear();
        window.testRequests = [];
        window.testSetFileRequests = [];
        window.testCreateDirRequests = [];
        window.testGetDirRequests = [];
        window.testUnexpectedNetwork = [];
        window.testHoldSetFileAcks = false;
        window.testRespond507 = false;
        window.testFailFileNames = [];
        window.testDirListings = {};
        window.testPendingSetFileAcks = [];
        window.testConcurrentSetFile = 0;
        window.testMaxConcurrentSetFile = 0;

        window.fetch = async url => {
            window.testUnexpectedNetwork.push(String(url));
            throw new Error('Unexpected fetch: network is disabled in this test');
        };
        navigator.sendBeacon = url => {
            window.testUnexpectedNetwork.push(String(url));
            return false;
        };

        window.makeResponse = function (commandId, params) {
            const encoded = (params || []).map(part => new TextEncoder().encode(String(part)));
            let total = 4;
            for (const part of encoded) {
                total += 4 + part.byteLength;
            }
            const response = new Uint8Array(total);
            const view = new DataView(response.buffer);
            view.setInt32(0, commandId, true);
            let offset = 4;
            for (const part of encoded) {
                view.setUint32(offset, part.byteLength, true);
                offset += 4;
                response.set(part, offset);
                offset += part.byteLength;
            }
            return btoa(String.fromCharCode.apply(null, response));
        };

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
                window.testRequests.push({ command: commandId, payload });

                const respond = (responseCommandId, params) => {
                    this.responseText = window.makeResponse(responseCommandId, params);
                    this.status = 200;
                    this.readyState = this.DONE = 4;
                    if (this.onload) {
                        this.onload.call(this);
                    }
                };

                if (commandId === command.SetFile) {
                    const json = JSON.parse(payload);
                    window.testSetFileRequests.push({
                        fullName: json.FullName,
                        chunkPart: json.ChunkPart,
                        totalChunk: json.TotalChunk,
                        data: json.Data,
                    });
                    window.testConcurrentSetFile++;
                    window.testMaxConcurrentSetFile = Math.max(
                        window.testMaxConcurrentSetFile,
                        window.testConcurrentSetFile
                    );
                    const shouldFail = window.testFailFileNames.includes(json.FullName);
                    let responded = false;
                    const finish = () => {
                        if (responded) {
                            return;
                        }
                        responded = true;
                        window.testConcurrentSetFile--;
                        if (shouldFail) {
                            this.status = 0;
                            this.readyState = this.DONE = 4;
                            if (this.onerror) {
                                this.onerror.call(this);
                            }
                            return;
                        }
                        respond(command.SetFile, [
                            window.testRespond507 ? '507' : json.FullName + '\t' + json.ChunkPart,
                        ]);
                    };
                    if (window.testHoldSetFileAcks) {
                        window.testPendingSetFileAcks.push(finish);
                        return;
                    }
                    queueMicrotask(finish);
                    return;
                }

                if (commandId === command.CreateDir) {
                    window.testCreateDirRequests.push({ payload });
                    const pathPart = payload.split('\t')[0];
                    queueMicrotask(() => respond(command.CreateDir, [pathPart, '[]']));
                    return;
                }

                if (commandId === command.GetDir) {
                    window.testGetDirRequests.push(payload);
                    const listing = window.testDirListings[payload] || [];
                    queueMicrotask(() => respond(command.GetDir, [payload, JSON.stringify(listing)]));
                    return;
                }
            }
        };

        window.releaseSetFileAck = function () {
            const next = window.testPendingSetFileAcks.shift();
            if (next) {
                next();
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
    await page.goto(clientUrl);
    await page.waitForFunction(() => session.clientId != null);
    await page.evaluate(() => {
        session.deviceKey = 'test-only-transport-key';
        proxy = 'https://mock-cloud.invalid';
        encryptDataForTheDevice = async data => data;
        decryptDataFromTheDevice = async data => data;
    });
    return page;
}

async function resetCounters(page) {
    await page.evaluate(() => {
        window.testRequests.length = 0;
        window.testSetFileRequests.length = 0;
        window.testCreateDirRequests.length = 0;
        window.testGetDirRequests.length = 0;
        window.testConcurrentSetFile = 0;
        window.testMaxConcurrentSetFile = 0;
        window.testPendingSetFileAcks.length = 0;
        window.testFailFileNames.length = 0;
    });
}

async function waitForBatch(page, expectedSetFiles, expectedCreateDirs, expectedGetDirs = 1) {
    await page.waitForFunction(({ expectedSetFiles, expectedCreateDirs }) => {
        const active = Object.keys(uploadSessions).filter(key => uploadSessions[key]);
        return window.testSetFileRequests.length === expectedSetFiles &&
            window.testCreateDirRequests.length === expectedCreateDirs &&
            active.length === 0 &&
            !uploadBatchRunning &&
            uploadBatchQueue.length === 0;
    }, { expectedSetFiles, expectedCreateDirs });
    if (expectedGetDirs != null) {
        await page.waitForFunction(n => window.testGetDirRequests.length >= n, expectedGetDirs);
    }
}

async function dropSpec(page, spec) {
    await page.evaluate(spec => {
        function buildEntry(node) {
            if (node.type === 'file') {
                const file = new File(
                    [Uint8Array.from(node.bytes || [])],
                    node.name,
                    { lastModified: node.lastModified || 1700000000000 }
                );
                return {
                    isFile: true,
                    isDirectory: false,
                    name: node.name,
                    file(success) {
                        success(file);
                    },
                };
            }
            const children = (node.children || []).map(buildEntry);
            let index = 0;
            return {
                isFile: false,
                isDirectory: true,
                name: node.name,
                createReader() {
                    return {
                        readEntries(success) {
                            if (index >= children.length) {
                                success([]);
                                return;
                            }
                            // Return one at a time so the client must keep reading.
                            success([children[index++]]);
                        },
                    };
                },
            };
        }

        function buildHandle(node) {
            if (node.type === 'file') {
                return {
                    kind: 'file',
                    name: node.name,
                    async getFile() {
                        return new File([Uint8Array.from(node.bytes || [])], node.name,
                            { lastModified: node.lastModified || 1700000000000 });
                    },
                };
            }
            return {
                kind: 'directory',
                name: node.name,
                async *values() {
                    for (const child of node.children || []) {
                        yield buildHandle(child);
                    }
                },
            };
        }

        let handlingDrop = true;
        window.testLegacyDropReads = 0;
        window.testDropHandleCaptures = [];
        const dataTransfer = {
            items: spec.roots.map(root => {
                const entry = buildEntry(root);
                if (spec.legacyReadError && entry.isDirectory) {
                    entry.createReader = () => ({
                        readEntries(success, error) {
                            window.testLegacyDropReads++;
                            error(new DOMException('Malformed filesystem URI', 'EncodingError'));
                        },
                    });
                }
                return {
                    kind: 'file',
                    webkitGetAsEntry: () => spec.noLegacyEntries ? null : entry,
                    getAsFile: () => spec.useHandles ? new File([], root.name) : null,
                    ...(spec.useHandles ? {
                        getAsFileSystemHandle() {
                            window.testDropHandleCaptures.push({ name: root.name, handlingDrop });
                            if (!handlingDrop) return Promise.resolve(null);
                            if (spec.handleError) return Promise.reject(new Error('Handles unavailable'));
                            if (spec.nullHandles) return Promise.resolve(null);
                            return Promise.resolve(buildHandle(root));
                        },
                    } : {}),
                };
            }),
            files: [],
        };
        const result = dropHandler({ preventDefault() {}, stopPropagation() {}, dataTransfer });
        handlingDrop = false;
        return result;
    }, spec);
}

function makeTree(t, structure, fixtureRoot = os.tmpdir()) {
    fixtureRoot = path.resolve(fixtureRoot);
    const base = mkdtempSync(path.join(fixtureRoot, 'cloud-folder-upload-'));
    t.after(() => {
        assert.equal(path.dirname(base), fixtureRoot);
        rmSync(base, { recursive: true, force: true });
    });

    function writeNode(node, relativePath) {
        const fullPath = path.join(base, relativePath);
        if (node.type === 'file') {
            mkdirSync(path.dirname(fullPath), { recursive: true });
            writeFileSync(fullPath, Buffer.from(node.bytes || []));
            return;
        }
        mkdirSync(fullPath, { recursive: true });
        for (const child of node.children || []) {
            writeNode(child, relativePath + '/' + child.name);
        }
    }

    const root = structure.roots[0];
    writeNode(root, root.name);
    return path.join(base, root.name);
}

test('folder picker creates parent folders before uploading nested files', async t => {
    const page = await openClient(t);
    assert.equal(await page.locator('#uploadFilesButton').isDisabled(), true);
    assert.equal(await page.locator('#uploadFolderButton').isDisabled(), true);
    await page.evaluate(async () => {
        await onCommandResponse.GetDir([stringToBuffer('base'), stringToBuffer('[]')]);
    });
    assert.equal(await page.locator('#uploadFilesButton').isEnabled(), true);
    assert.equal(await page.locator('#uploadFolderButton').isEnabled(), true);
    await resetCounters(page);

    const folder = makeTree(t, {
        roots: [{
            name: 'Root',
            type: 'dir',
            children: [
                { name: 'a.txt', type: 'file', bytes: [1, 2, 3] },
                {
                    name: 'sub', type: 'dir', children: [
                        { name: 'b.bin', type: 'file', bytes: [4, 5] },
                        {
                            name: 'deeper', type: 'dir', children: [
                                { name: 'c.bin', type: 'file', bytes: [6] },
                            ],
                        },
                    ],
                },
            ],
        }],
    });

    await page.locator('#uploadFolderInput').setInputFiles(folder);
    await waitForBatch(page, 3, 3);

    const state = await page.evaluate(() => ({
        createDirs: window.testCreateDirRequests.map(request => request.payload),
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        requests: window.testRequests.map(request => request.command),
        getDirs: window.testGetDirRequests.slice(),
        bars: document.querySelectorAll('#topBar progress').length,
    }));

    assert.deepEqual(state.createDirs, [
        'base\tRoot',
        'base/Root\tsub',
        'base/Root/sub\tdeeper',
    ]);
    assert.deepEqual(state.setFiles.sort(), [
        'base/Root/a.txt',
        'base/Root/sub/b.bin',
        'base/Root/sub/deeper/c.bin',
    ].sort());
    const firstSetFile = state.requests.indexOf(8);
    assert.ok(firstSetFile > 0, 'Uploads were sent');
    assert.equal(state.requests.slice(0, firstSetFile).filter(id => id === 13).length, 3);
    assert.equal(state.requests.slice(firstSetFile).filter(id => id === 13).length, 0);
    assert.equal(state.getDirs.length, 1);
    assert.equal(state.bars, 0);
});

test('drag and drop recursively uploads nested folders and creates empty folders', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'dropbase';
    });
    await resetCounters(page);

    await dropSpec(page, {
        roots: [{
            name: 'Root',
            type: 'dir',
            children: [
                { name: 'one.txt', type: 'file', bytes: [10, 11] },
                {
                    name: 'sub',
                    type: 'dir',
                    children: [
                        { name: 'two.txt', type: 'file', bytes: [12] },
                    ],
                },
                { name: 'empty', type: 'dir', children: [] },
            ],
        }],
    });
    await waitForBatch(page, 2, 2);

    const state = await page.evaluate(() => ({
        createDirs: window.testCreateDirRequests.map(request => request.payload),
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        getDirs: window.testGetDirRequests.slice(),
    }));

    assert.deepEqual(state.createDirs, [
        'dropbase\tRoot',
        'dropbase/Root\tempty\tsub',
    ]);
    assert.deepEqual(state.setFiles.sort(), [
        'dropbase/Root/one.txt',
        'dropbase/Root/sub/two.txt',
    ].sort());
    assert.equal(state.getDirs.length, 1);
    assert.equal(await page.evaluate(() => uploadBatchQueue.length), 0);
});

test('null dropped entries are skipped without breaking valid uploads', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'nullbase';
    });
    await resetCounters(page);

    await page.evaluate(() => {
        const bytes = new Uint8Array([7]);
        const file = new File([bytes], 'valid.txt', { lastModified: 1700000000000 });
        const validEntry = {
            isFile: true,
            isDirectory: false,
            name: 'valid.txt',
            file(success) {
                success(file);
            },
        };
        const dataTransfer = {
            items: [
                { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => null },
                { kind: 'file', webkitGetAsEntry: () => validEntry, getAsFile: () => null },
            ],
            files: [],
        };
        return dropHandler({ preventDefault() {}, stopPropagation() {}, dataTransfer });
    });
    await waitForBatch(page, 1, 0);

    const state = await page.evaluate(() => ({
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        alert: document.getElementById('alertBox').innerText,
    }));
    assert.deepEqual(state.setFiles, ['nullbase/valid.txt']);
    assert.match(state.alert, /could not be read/i);
});

test('dropping on the bottom toolbar uploads the item only once', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'droponce';
    });
    await resetCounters(page);

    await page.evaluate(() => {
        const file = new File([new Uint8Array([1, 2])], 'once.txt', { lastModified: 1700000000000 });
        const entry = {
            isFile: true,
            isDirectory: false,
            name: 'once.txt',
            file(success) {
                success(file);
            },
        };
        const dataTransfer = {
            items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null }],
            files: [],
        };
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
        document.getElementById('bottom').dispatchEvent(event);
    });
    await waitForBatch(page, 1, 0);
    await page.waitForTimeout(300);

    const state = await page.evaluate(() => ({
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        bars: document.querySelectorAll('#topBar progress').length,
    }));
    assert.deepEqual(state.setFiles, ['droponce/once.txt']);
    assert.equal(state.bars, 0);
});

test('drops fall back to dataTransfer.files when entries are unavailable', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'fallback';
    });
    await resetCounters(page);

    await page.evaluate(async () => {
        await startSendFile(null, false);
        const file = new File([new Uint8Array([1, 2])], 'fallback.txt', { lastModified: 1700000000000 });
        const dataTransfer = { items: [], files: [file] };
        await dropHandler({ preventDefault() {}, stopPropagation() {}, dataTransfer });
    });
    await waitForBatch(page, 1, 0);

    const state = await page.evaluate(() => ({
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        bars: document.querySelectorAll('#topBar progress').length,
    }));
    assert.deepEqual(state.setFiles, ['fallback/fallback.txt']);
    assert.equal(state.bars, 0);
});

test('top-level file drops use getAsFile when entry.file fails', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'readerbase';
    });
    await resetCounters(page);

    await page.evaluate(async () => {
        window.testEntryFileCalled = false;
        const file = new File(
            [new Uint8Array([1, 2, 3])],
            '1782805900123.pdf',
            { lastModified: 1700000000000 }
        );
        const entry = {
            isFile: true,
            isDirectory: false,
            name: '1782805900123.pdf',
            file(success, error) {
                window.testEntryFileCalled = true;
                error(new DOMException('synthetic EncodingError', 'EncodingError'));
            },
        };
        const dataTransfer = {
            items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => file }],
            files: [file],
        };
        await dropHandler({ preventDefault() {}, stopPropagation() {}, dataTransfer });
    });
    await waitForBatch(page, 1, 0);

    const state = await page.evaluate(() => ({
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        entryFileCalled: window.testEntryFileCalled,
        alert: document.getElementById('alertBox').innerText,
    }));
    assert.deepEqual(state.setFiles, ['readerbase/1782805900123.pdf']);
    assert.equal(state.entryFileCalled, false);
    assert.equal(state.alert, '');
});

test('unreadable dropped directories are reported without creating empty folders', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'readfail';
    });
    await resetCounters(page);

    await page.evaluate(async () => {
        const entry = {
            isFile: false,
            isDirectory: true,
            name: 'UnreadableRoot',
            createReader() {
                return {
                    readEntries(success, error) {
                        error(new DOMException('synthetic EncodingError', 'EncodingError'));
                    },
                };
            },
        };
        const dataTransfer = {
            items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null }],
            files: [],
        };
        await dropHandler({ preventDefault() {}, stopPropagation() {}, dataTransfer });
    });

    const state = await page.evaluate(() => ({
        createDirs: window.testCreateDirRequests.length,
        setFiles: window.testSetFileRequests.length,
        alert: document.getElementById('alertBox').innerText,
        running: uploadBatchRunning,
    }));
    assert.equal(state.createDirs, 0);
    assert.equal(state.setFiles, 0);
    assert.match(state.alert, /Could not read 1 dropped item/i);
    assert.match(state.alert, /Upload buttons/i);
    assert.equal(state.running, false);
});

test('native folder drops from a local HTML file upload actual files and empty folders', async t => {
    const page = await openClient(t, { localFile: true });
    await page.evaluate(() => { currentPath = 'native'; });
    await resetCounters(page);
    // Chromium restricts directory handles under AppData (including os.tmpdir()).
    // Keep this synthetic native-drop fixture in the test directory instead.
    const folder = makeTree(t, { roots: [{
        type: 'dir', name: 'samplePdf', children: [
            { type: 'file', name: 'report #100% ə.pdf', bytes: [1, 2, 3] },
            { type: 'dir', name: 'nested', children: [
                { type: 'file', name: 'empty.txt', bytes: [] },
            ] },
            { type: 'dir', name: 'empty', children: [] },
        ],
    }] }, __dirname);
    const target = await page.locator('#topBar').boundingBox();
    assert.ok(target, 'The upload drop area is visible');
    const cdp = await page.context().newCDPSession(page);
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.send('Input.dispatchDragEvent', {
            type,
            x: target.x + target.width / 2,
            y: target.y + target.height / 2,
            data: { items: [], files: [folder], dragOperationsMask: 1 },
        });
    }
    await waitForBatch(page, 2, 2);
    const state = await page.evaluate(() => ({
        protocol: location.protocol,
        directories: window.testCreateDirRequests.map(r => r.payload),
        uploads: window.testSetFileRequests.map(r => ({
            path: r.fullName, bytes: Array.from(new Uint8Array(base64ToBuffer(r.data))),
        })).sort((a, b) => a.path.localeCompare(b.path)),
        alert: document.getElementById('alertBox').innerText,
    }));
    assert.equal(state.protocol, 'file:');
    assert.deepEqual(state.directories, [
        'native\tsamplePdf', 'native/samplePdf\tempty\tnested',
    ]);
    assert.deepEqual(state.uploads, [
        { path: 'native/samplePdf/nested/empty.txt', bytes: [] },
        { path: 'native/samplePdf/report #100% ə.pdf', bytes: [1, 2, 3] },
    ]);
    assert.equal(state.alert, '');
});

for (const noLegacyEntries of [false, true]) {
    test(`folder handles upload nested files when legacy entries are ${noLegacyEntries ? 'missing' : 'unreadable'}`, async t => {
        const page = await openClient(t);
        await page.evaluate(() => { currentPath = 'handles'; });
        await resetCounters(page);

        await dropSpec(page, {
            useHandles: true,
            legacyReadError: true,
            noLegacyEntries,
            roots: [{
                type: 'dir', name: 'samplePdf', children: [
                    { type: 'file', name: 'report #100% ə.pdf', bytes: [1, 2, 3] },
                    { type: 'dir', name: 'nested', children: [
                        { type: 'file', name: 'empty.txt', bytes: [] },
                    ] },
                    { type: 'dir', name: 'empty', children: [] },
                ],
            }, {
                type: 'dir', name: 'second', children: [
                    { type: 'file', name: 'second.txt', bytes: [4] },
                ],
            }],
        });
        const state = await page.evaluate(() => ({
            files: uploadSummaryState.jobs.map(job => job.relativePath).sort(),
            legacyReads: window.testLegacyDropReads,
            captures: window.testDropHandleCaptures,
            alert: document.getElementById('alertBox').innerText,
        }));
        assert.deepEqual(state.files, [
            'samplePdf/nested/empty.txt', 'samplePdf/report #100% ə.pdf', 'second/second.txt',
        ]);
        assert.equal(state.legacyReads, 0);
        assert.deepEqual(state.captures, [
            { name: 'samplePdf', handlingDrop: true }, { name: 'second', handlingDrop: true },
        ]);
        assert.equal(state.alert, '');
        await waitForBatch(page, 3, 2);
        assert.deepEqual(await page.evaluate(() => window.testCreateDirRequests.map(r => r.payload)), [
            'handles\tsamplePdf\tsecond', 'handles/samplePdf\tempty\tnested',
        ]);
        const uploads = await page.evaluate(() => window.testSetFileRequests.map(r => ({
            path: r.fullName, bytes: Array.from(new Uint8Array(base64ToBuffer(r.data))),
        })).sort((a, b) => a.path.localeCompare(b.path)));
        assert.deepEqual(uploads, [
            { path: 'handles/samplePdf/nested/empty.txt', bytes: [] },
            { path: 'handles/samplePdf/report #100% ə.pdf', bytes: [1, 2, 3] },
            { path: 'handles/second/second.txt', bytes: [4] },
        ]);
    });
}

for (const failure of ['handleError', 'nullHandles']) {
    test(`folder drops use legacy traversal when handle acquisition returns ${failure}`, async t => {
        const page = await openClient(t);
        await page.evaluate(() => { currentPath = 'legacy'; });
        await resetCounters(page);
        await dropSpec(page, {
            useHandles: true,
            [failure]: true,
            roots: [{ type: 'dir', name: 'Root', children: [
                { type: 'file', name: 'one.txt', bytes: [9] },
            ] }],
        });
        await waitForBatch(page, 1, 1);
        assert.deepEqual(await page.evaluate(() => window.testSetFileRequests.map(r => r.fullName)),
            ['legacy/Root/one.txt']);
        assert.equal(await page.locator('#alertBox').innerText(), '');
    });
}

test('empty files upload one zero-byte chunk', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'emptybase';
    });
    await resetCounters(page);

    await dropSpec(page, {
        roots: [{
            name: 'Root',
            type: 'dir',
            children: [
                { name: 'empty.bin', type: 'file', bytes: [] },
            ],
        }],
    });
    await waitForBatch(page, 1, 1);

    const state = await page.evaluate(() => {
        const request = window.testSetFileRequests[0];
        return {
            fullName: request.fullName,
            chunkPart: request.chunkPart,
            totalChunk: request.totalChunk,
            bytes: base64ToBuffer(request.data).byteLength,
        };
    });
    assert.deepEqual(state, {
        fullName: 'emptybase/Root/empty.bin',
        chunkPart: 1,
        totalChunk: 1,
        bytes: 0,
    });
});

test('empty dropped folders are created without starting an upload', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'emptyfolder';
    });
    await resetCounters(page);

    await dropSpec(page, {
        roots: [{ name: 'EmptyRoot', type: 'dir', children: [] }],
    });
    await waitForBatch(page, 0, 1);

    const state = await page.evaluate(() => ({
        createDirs: window.testCreateDirRequests.map(request => request.payload),
        setFiles: window.testSetFileRequests.length,
        getDirs: window.testGetDirRequests.length,
    }));
    assert.deepEqual(state.createDirs, ['emptyfolder\tEmptyRoot']);
    assert.equal(state.setFiles, 0);
    assert.equal(state.getDirs, 1);
});

test('multi-file folder uploads keep at most two files in flight', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'queuebase';
        window.testHoldSetFileAcks = true;
    });
    await resetCounters(page);

    await dropSpec(page, {
        roots: [{
            name: 'QueueRoot',
            type: 'dir',
            children: Array.from({ length: 6 }, (_, index) => ({
                name: 'file' + index + '.bin',
                type: 'file',
                bytes: [index],
            })),
        }],
    });

    await page.waitForFunction(() => window.testSetFileRequests.length === 2);
    const held = await page.evaluate(() => ({
        maxConcurrent: window.testMaxConcurrentSetFile,
        activeSessions: Object.keys(uploadSessions).filter(key => uploadSessions[key]).length,
        bars: document.querySelectorAll('#topBar progress').length,
        pendingAcks: window.testPendingSetFileAcks.length,
    }));
    assert.equal(held.maxConcurrent, 2);
    assert.equal(held.activeSessions, 2);
    assert.equal(held.bars, 2);
    assert.equal(held.pendingAcks, 2);

    for (let i = 0; i < 6; i++) {
        await page.waitForFunction(() => window.testPendingSetFileAcks.length > 0);
        await page.evaluate(() => window.releaseSetFileAck());
    }
    await waitForBatch(page, 6, 1);

    const finalState = await page.evaluate(() => ({
        maxConcurrent: window.testMaxConcurrentSetFile,
        setFiles: window.testSetFileRequests.map(request => request.fullName).sort(),
        bars: document.querySelectorAll('#topBar progress').length,
    }));
    assert.ok(finalState.maxConcurrent <= 2);
    assert.equal(finalState.setFiles.length, 6);
    assert.equal(finalState.bars, 0);
});

test('cancellation during encryption setup does not start another file', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'cancelbase';
        window.testHoldSetFileAcks = true;
        window.testRespond507 = false;
        window.testEncryptionCalls = 0;
        window.testSecondEncryptionStarted = false;
        window.testReleaseSecondEncryption = null;
        const originalCreateUploadEncryptionContext = createUploadEncryptionContext;
        createUploadEncryptionContext = async function (...args) {
            const result = await originalCreateUploadEncryptionContext.apply(this, args);
            window.testEncryptionCalls++;
            if (window.testEncryptionCalls === 2) {
                window.testSecondEncryptionStarted = true;
                await new Promise(resolve => {
                    window.testReleaseSecondEncryption = resolve;
                });
            }
            return result;
        };
    });
    await resetCounters(page);

    await dropSpec(page, {
        roots: [{
            name: 'CancelRoot',
            type: 'dir',
            children: [
                { name: 'a.bin', type: 'file', bytes: [1] },
                { name: 'b.bin', type: 'file', bytes: [2] },
            ],
        }],
    });

    await page.waitForFunction(() =>
        window.testSecondEncryptionStarted && window.testSetFileRequests.length === 1
    );

    // Fail the first in-flight chunk with 507. failAllUploads cancels the batch.
    await page.evaluate(() => {
        window.testRespond507 = true;
        window.releaseSetFileAck();
    });
    await page.waitForFunction(() =>
        uploadBatchCancelled &&
        Object.keys(uploadSessions).filter(key => uploadSessions[key]).length === 0
    );

    // Let the second file finish its delayed encryption setup. It must not start.
    await page.evaluate(() => {
        if (typeof window.testReleaseSecondEncryption === 'function') {
            window.testReleaseSecondEncryption();
            window.testReleaseSecondEncryption = null;
        }
    });
    await page.waitForFunction(() => !uploadBatchRunning);
    await page.waitForTimeout(300);

    const state = await page.evaluate(() => ({
        encryptionCalls: window.testEncryptionCalls,
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        activeSessions: Object.keys(uploadSessions).filter(key => uploadSessions[key]).length,
        bars: document.querySelectorAll('#topBar progress').length,
        alert: document.getElementById('alertBox').innerText,
    }));
    assert.equal(state.encryptionCalls, 2);
    assert.equal(state.setFiles.length, 1);
    assert.equal(state.activeSessions, 0);
    assert.equal(state.bars, 0);
    assert.match(state.alert, /no space/i);
});

test('upload summary reports queued, active, completed, and final state', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'summarybase';
        window.testHoldSetFileAcks = true;
    });
    await resetCounters(page);

    await dropSpec(page, {
        roots: [{
            name: 'SummaryRoot',
            type: 'dir',
            children: Array.from({ length: 6 }, (_, index) => ({
                name: 'file' + index + '.bin',
                type: 'file',
                bytes: [index],
            })),
        }],
    });

    await page.waitForFunction(() => window.testSetFileRequests.length === 2);
    await page.waitForFunction(() => {
        const text = document.getElementById('uploadQueueSummaryText').innerText;
        return text.includes('0 / 6 done') &&
            text.includes('2 active') &&
            text.includes('4 queued');
    });
    assert.equal(await page.locator('#uploadQueueSummaryDismiss').isHidden(), true);

    for (let i = 0; i < 6; i++) {
        await page.waitForFunction(() => window.testPendingSetFileAcks.length > 0);
        await page.evaluate(() => window.releaseSetFileAck());
    }
    await waitForBatch(page, 6, 1);
    await page.waitForFunction(() =>
        document.getElementById('uploadQueueSummaryText').innerText.includes('Upload complete: 6 files')
    );

    assert.equal(await page.locator('#uploadQueueSummary').isVisible(), true);
    assert.equal(await page.locator('#uploadQueueSummaryDismiss').isVisible(), true);
    assert.equal(await page.locator('#uploadQueueFailures').isHidden(), true);

    await page.locator('#uploadQueueSummaryDismiss').click();
    assert.equal(await page.locator('#uploadQueueSummary').isHidden(), true);
});

test('failed batch files are summarized without stopping the queue', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'failbase';
    });
    await resetCounters(page);
    await page.evaluate(() => {
        window.testFailFileNames.push('failbase/FailRoot/b.bin');
    });

    await dropSpec(page, {
        roots: [{
            name: 'FailRoot',
            type: 'dir',
            children: [
                { name: 'a.bin', type: 'file', bytes: [1] },
                { name: 'b.bin', type: 'file', bytes: [2] },
                { name: 'c.bin', type: 'file', bytes: [3] },
            ],
        }],
    });
    await waitForBatch(page, 3, 1);
    await page.waitForFunction(() => {
        const text = document.getElementById('uploadQueueSummaryText').innerText;
        return text.includes('2 complete') && text.includes('1 failed');
    });

    const state = await page.evaluate(() => ({
        text: document.getElementById('uploadQueueSummaryText').innerText,
        failuresVisible: !document.getElementById('uploadQueueFailures').hidden,
        failures: document.getElementById('uploadQueueFailuresList').textContent,
        alert: document.getElementById('alertBox').innerText,
    }));
    assert.match(state.text, /2 complete/);
    assert.match(state.text, /1 failed/);
    assert.equal(state.failuresVisible, true);
    assert.match(state.failures, /FailRoot\/b\.bin/);
    assert.equal(state.alert, '');
});

test('queued batches are visible in the summary', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'batchwait';
        window.testHoldSetFileAcks = true;
    });
    await resetCounters(page);

    await dropSpec(page, {
        roots: [{
            name: 'FirstBatch',
            type: 'dir',
            children: [
                { name: 'a.bin', type: 'file', bytes: [1] },
                { name: 'b.bin', type: 'file', bytes: [2] },
            ],
        }],
    });
    await page.waitForFunction(() => window.testSetFileRequests.length === 2);

    await dropSpec(page, {
        roots: [{
            name: 'SecondBatch',
            type: 'dir',
            children: [
                { name: 'c.bin', type: 'file', bytes: [3] },
            ],
        }],
    });
    await page.waitForFunction(() => {
        const text = document.getElementById('uploadQueueSummaryText').innerText;
        return text.includes('/ 3 done') &&
            text.includes('2 active') &&
            text.includes('1 queued') &&
            text.includes('1 batch waiting');
    });

    for (let i = 0; i < 3; i++) {
        await page.waitForFunction(() => window.testPendingSetFileAcks.length > 0);
        await page.evaluate(() => window.releaseSetFileAck());
    }
    await waitForBatch(page, 3, 2, 2);
    await page.waitForFunction(() =>
        document.getElementById('uploadQueueSummaryText').innerText.includes('Upload complete: 3 files')
    );
});

test('selection survives same-directory refresh and is not carried across navigation', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        window.testDirListings['selection'] = [
            { Name: 'alpha.txt', IsDirectory: false, Length: 1, Date: '2026-01-01T00:00:00Z' },
            { Name: 'beta.txt', IsDirectory: false, Length: 2, Date: '2026-01-01T00:00:00Z' },
        ];
        window.testDirListings['other'] = [
            { Name: 'gamma.txt', IsDirectory: false, Length: 3, Date: '2026-01-01T00:00:00Z' },
        ];
    });

    await page.evaluate(async () => {
        await getDir('selection');
    });
    await page.waitForFunction(() =>
        currentPath === 'selection' && document.querySelectorAll('.fileSelector').length === 2
    );
    await page.locator('.fileSelector').first().check();
    assert.equal(await page.locator('.fileSelector').first().isChecked(), true);

    await page.evaluate(async () => {
        await getDir('selection');
    });
    await page.waitForFunction(() =>
        currentPath === 'selection' && document.querySelectorAll('.fileSelector').length === 2
    );
    assert.equal(await page.locator('.fileSelector').first().isChecked(), true);
    assert.equal(await page.locator('.fileSelector').nth(1).isChecked(), false);

    await page.evaluate(async () => {
        await getDir('other');
    });
    await page.waitForFunction(() =>
        currentPath === 'other' && document.querySelectorAll('.fileSelector').length === 1
    );
    assert.equal(await page.locator('.fileSelector').first().isChecked(), false);
});

test('ZK folder upload encrypts folders and files and decrypts to the original structure', async t => {
    const page = await openClient(t);
    await page.evaluate(async passphrase => {
        zeroKnowledgeEnabled = true;
        setZeroKnowledgePassphrase(passphrase);
        await initializeZeroKnowledgeState();
        currentPath = 'zkbase';
    }, ZK_PASSPHRASE);
    await resetCounters(page);

    const folder = makeTree(t, {
        roots: [{
            name: 'ZkRoot',
            type: 'dir',
            children: [
                { name: 'clear-a.txt', type: 'file', bytes: [1] },
                {
                    name: 'zk-sub',
                    type: 'dir',
                    children: [
                        { name: 'clear-b.txt', type: 'file', bytes: [2] },
                    ],
                },
            ],
        }],
    });

    await page.locator('#uploadFolderInput').setInputFiles(folder);
    await waitForBatch(page, 2, 2);

    const state = await page.evaluate(async () => {
        const key = getZeroKnowledgeState().filenameObfuscationKey;
        const files = [];
        for (const request of window.testSetFileRequests) {
            files.push(decryptFullFileNameZk(request.fullName, key));
        }
        const directories = [];
        for (const request of window.testCreateDirRequests) {
            const parts = request.payload.split('\t');
            const parent = await decryptPathForUi(parts[0]);
            directories.push({
                parent,
                names: parts.slice(1).map(name => decryptFileNameZk(name, key)),
            });
        }
        return {
            files,
            directories,
            encryptedNames: window.testSetFileRequests.map(request => request.fullName),
            getDirs: window.testGetDirRequests.length,
        };
    });

    assert.deepEqual(state.files.sort(), [
        'zkbase/ZkRoot/clear-a.txt',
        'zkbase/ZkRoot/zk-sub/clear-b.txt',
    ].sort());
    assert.deepEqual(state.directories, [
        { parent: 'zkbase', names: ['ZkRoot'] },
        { parent: 'zkbase/ZkRoot', names: ['zk-sub'] },
    ]);
    assert.ok(state.encryptedNames.every(name => name.endsWith('\u2047')));
    assert.equal(state.getDirs, 1);
});

test('a 198-file folder preserves paths and refreshes once', async t => {
    const page = await openClient(t);
    await page.evaluate(() => {
        currentPath = 'batch198';
    });
    await resetCounters(page);

    const directoryCount = 20;
    let created = 0;
    const directories = [];
    for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex++) {
        const files = [];
        const fileCount = directoryIndex < 18 ? 10 : 9;
        for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
            files.push({
                name: 'file' + fileIndex + '.bin',
                type: 'file',
                bytes: [],
            });
            created++;
        }
        directories.push({
            name: 'd' + String(directoryIndex).padStart(2, '0'),
            type: 'dir',
            children: files,
        });
    }
    assert.equal(created, 198);

    const folder = makeTree(t, {
        roots: [{
            name: 'Root198',
            type: 'dir',
            children: directories,
        }],
    });

    const started = Date.now();
    await page.locator('#uploadFolderInput').setInputFiles(folder);
    await waitForBatch(page, 198, 2);
    await page.waitForFunction(() =>
        document.getElementById('uploadQueueSummaryText').innerText.includes('Upload complete: 198 files')
    );

    const state = await page.evaluate(() => ({
        setFiles: window.testSetFileRequests.map(request => request.fullName),
        createDirs: window.testCreateDirRequests.map(request => request.payload),
        getDirs: window.testGetDirRequests.length,
        maxConcurrent: window.testMaxConcurrentSetFile,
        bars: document.querySelectorAll('#topBar progress').length,
        summary: document.getElementById('uploadQueueSummaryText').innerText,
    }));

    assert.equal(state.setFiles.length, 198);
    assert.equal(new Set(state.setFiles).size, 198);
    assert.ok(state.setFiles.every(name => name.startsWith('batch198/Root198/d')));
    assert.equal(state.createDirs.length, 2);
    assert.equal(state.createDirs[0], 'batch198\tRoot198');
    assert.equal(state.createDirs[1].split('\t').length, 21);
    assert.equal(state.getDirs, 1);
    assert.ok(state.maxConcurrent <= 2);
    assert.equal(state.bars, 0);
    assert.match(state.summary, /Upload complete: 198 files/);
    assert.ok(Date.now() - started < 60000, '198-file test should finish in under a minute');
});

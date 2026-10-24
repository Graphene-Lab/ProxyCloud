const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const html = readFileSync(path.join(__dirname, '..', 'CryptoCloudClientWeb.html'), 'utf8');
const notice = 'Rename, Move and Copy are temporarily unavailable to protect files encrypted with zero-knowledge encryption.';
const file = { Name: 'photo.jpg', IsDirectory: false, Length: 3, Date: '2026-01-01T00:00:00Z' };
const folder = { Name: 'encrypted-descendants', IsDirectory: true, Date: '2026-01-01T00:00:00Z' };
const selections = { file: [file], folder: [folder], bulk: [file, folder] };
const operations = { rename: 10, move: 11, copy: 12 };
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

async function openClient(t, storedPassphrase = '') {
    // Each test uses a fresh profile, synthetic files, and fail-closed network access.
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
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
    await context.routeWebSocket('**/*', socket => {
        unexpectedNetwork.push(socket.url());
        socket.close();
    });
    await context.addInitScript(({ storedPassphrase }) => {
        localStorage.clear();
        if (storedPassphrase) localStorage.setItem('cloud.zk.passphrase', storedPassphrase);
        window.testRequests = [];
        window.testUnexpectedNetwork = [];
        window.fetch = async url => {
            window.testUnexpectedNetwork.push(String(url));
            throw new Error('Unexpected fetch: network is disabled in this test');
        };
        navigator.sendBeacon = url => {
            window.testUnexpectedNetwork.push(String(url));
            return false;
        };
        window.XMLHttpRequest = class {
            open(method, url) { this.method = method; this.url = url; }
            send(data) {
                const bytes = data || new ArrayBuffer(0);
                window.testRequests.push({
                    method: this.method,
                    url: this.url,
                    command: bytes.byteLength >= 4 ? bufferToInt(bytes.slice(0, 4)) : null,
                    payload: bytes.byteLength >= 4 ? bufferToString(bytes.slice(4)) : '',
                });
                queueMicrotask(() => {
                    this.status = 200;
                    this.readyState = this.DONE = 4;
                    this.responseText = '';
                    this.onload?.();
                });
            }
        };
        HTMLMediaElement.prototype.play = async () => {};
    }, { storedPassphrase });
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
        // Mock only transport encryption so captured XHR packets expose their command/payload.
        // Path/content encryption, controls, handlers and request scheduling remain the real code.
        encryptDataForTheDevice = async data => data;
    });
    return page;
}

async function setMode(page, enabled, withKey = false) {
    await page.locator('#zkEnabled').setChecked(enabled);
    if (withKey) {
        await page.locator('#zkpass').fill('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
        await page.evaluate(() => initializeZeroKnowledgeStateFromUi());
        assert.equal(await page.evaluate(() => getZeroKnowledgeState() != null), true);
    }
}

async function selectFiles(page, files) {
    // Append real file cards while retaining the real login checkbox for mode-change tests.
    await page.evaluate(files => {
        document.querySelectorAll('.fileContainer').forEach(element => element.remove());
        currentPath = 'source';
        files.forEach((entry, index) => addFile(entry, index + 1));
        updateButtonsStatus();
    }, files);
    for (const checkbox of await page.locator('.fileSelector').all()) await checkbox.check();
}

async function requests(page, count) {
    if (count != null) await page.waitForFunction(count => testRequests.length === count, count);
    return page.evaluate(() => testRequests);
}

for (const withKey of [false, true]) {
    for (const [selection, files] of Object.entries(selections)) {
        test(`enabled ${withKey ? 'with key' : 'without key'}: ${selection} controls are disabled`, async t => {
            const page = await openClient(t);
            await setMode(page, true, withKey);
            await selectFiles(page, files);
            assert.equal(await page.locator('#zkFileOperationsNotice').innerText(), notice);
            assert.equal(await page.locator('#zkFileOperationsNotice').isVisible(), true);
            await page.evaluate(() => { window.prompt = () => { throw new Error('A blocked operation opened a prompt'); }; });
            for (const operation of Object.keys(operations)) {
                assert.equal(await page.locator(`#${operation}`).isDisabled(), true);
                await page.locator(`#${operation}`).evaluate(button => button.click());
            }
            assert.deepEqual(await requests(page), []);
            assert.equal(await page.locator('#delete').isEnabled(), true);
            assert.equal(await page.locator('#addToFavorites').isEnabled(), true);
        });
    }
}

for (const [selection, files] of Object.entries(selections)) {
    for (const [operation, commandId] of Object.entries(operations)) {
        test(`disabled: ${operation} ${selection} sends the original request payload`, async t => {
            const page = await openClient(t);
            await selectFiles(page, files);
            assert.equal(await page.locator('#zkFileOperationsNotice').isVisible(), false);
            assert.equal(await page.locator(`#${operation}`).isEnabled(), true);
            if (operation === 'rename') {
                page.once('dialog', dialog => dialog.accept('new-name'));
                await page.locator('#rename').click();
            } else {
                await page.locator(`#${operation}`).click();
                assert.equal(await page.locator('#target').isEnabled(), true);
                await page.evaluate(() => { currentPath = 'destination'; });
                await page.locator('#target').click();
                assert.equal(await page.evaluate(() => document.getElementById('target').files), null);
            }
            const sent = await requests(page, 1);
            assert.equal(sent[0].command, commandId);
            assert.equal(sent[0].payload, ['source', ...files.map(file => file.Name), operation === 'rename' ? 'new-name' : 'destination'].join('\t'));
        });
    }
}

test('disabled: copying a single file in the same folder uses the entered copy name', async t => {
    const page = await openClient(t);
    await selectFiles(page, [file]);
    await page.locator('#copy').click();
    page.once('dialog', async dialog => {
        assert.equal(dialog.defaultValue(), 'copy_photo.jpg');
        await dialog.accept('duplicate.jpg');
    });
    await page.locator('#target').click();
    const sent = await requests(page, 1);
    assert.equal(sent[0].command, operations.copy);
    assert.equal(sent[0].payload, 'source\tphoto.jpg\tduplicate.jpg');
});

test('temporary restriction leaves direct operation calls and central requests unchanged', async t => {
    const page = await openClient(t);
    await setMode(page, true);
    await page.evaluate(async () => {
        await rename('source', ['photo.jpg'], 'renamed.jpg');
        await move('source', ['photo.jpg'], 'destination');
        await copy('source', ['photo.jpg'], 'destination');
        for (const commandId of [command.Rename, command.Move, command.Copy]) {
            executeRequest(commandId, 'synthetic-direct-call');
        }
    });
    const sent = await requests(page, 6);
    assert.deepEqual(sent.map(request => request.command).sort((a, b) => a - b), [10, 10, 11, 11, 12, 12]);
});

for (const [selection, files] of Object.entries(selections)) {
    for (const operation of ['move', 'copy']) {
        test(`open ${operation} destination for ${selection}: enabling blocks confirmation; disabling restores it`, async t => {
            const page = await openClient(t);
            await selectFiles(page, files);
            await page.locator(`#${operation}`).click();
            await page.evaluate(() => { currentPath = 'destination'; });
            await setMode(page, true);
            assert.equal(await page.locator('#target').isDisabled(), true);
            await page.locator('#target').evaluate(button => button.click());
            assert.deepEqual(await requests(page), []);
            await setMode(page, false);
            assert.equal(await page.locator('#target').isEnabled(), true);
            for (const id of ['rename', 'move', 'copy', 'delete']) {
                assert.equal(await page.locator(`#${id}`).isDisabled(), true, 'Existing destination-selection state is preserved');
            }
            await page.locator('#target').click();
            assert.equal((await requests(page, 1))[0].command, operations[operation]);
        });
    }
}

test('enabled state survives a real directory response removing login controls, with no key', async t => {
    const page = await openClient(t);
    await setMode(page, true);
    await page.evaluate(async files => {
        await onCommandResponse.GetDir([stringToBuffer('source'), stringToBuffer(JSON.stringify(files))]);
    }, [file, folder]);
    assert.equal(await page.locator('#zkEnabled').count(), 0);
    for (const checkbox of await page.locator('.fileSelector').all()) await checkbox.check();
    assert.equal(await page.evaluate(() => getZeroKnowledgeState()), null);
    for (const operation of Object.keys(operations)) assert.equal(await page.locator(`#${operation}`).isDisabled(), true);
    assert.deepEqual(await requests(page), []);
});

test('stored zero-knowledge sessions restore restricted controls before any selection', async t => {
    const page = await openClient(t, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    assert.equal(await page.locator('#zkEnabled').isChecked(), true);
    await selectFiles(page, [folder]);
    assert.equal(await page.locator('#rename').isDisabled(), true);
    // Losing the derived key does not disable the account-mode restriction.
    await page.evaluate(() => { setZeroKnowledgePassphrase(''); clearZeroKnowledgeCache(); });
    await page.evaluate(() => updateButtonsStatus());
    for (const id of ['rename', 'move', 'copy']) assert.equal(await page.locator(`#${id}`).isDisabled(), true);
});

test('toggling ZK off without a selection keeps the ordinary controls disabled', async t => {
    const page = await openClient(t);
    await setMode(page, true);
    await setMode(page, false);
    for (const id of ['rename', 'move', 'copy', 'delete', 'target']) {
        assert.equal(await page.locator(`#${id}`).isDisabled(), true);
    }
    assert.equal(await page.locator('#zkFileOperationsNotice').isVisible(), false);
});

test('turning mode off restores ordinary controls even with a cached passphrase', async t => {
    const page = await openClient(t);
    await setMode(page, true, true);
    await selectFiles(page, [folder]);
    await setMode(page, false);
    assert.equal(await page.evaluate(() => shouldUseZeroKnowledge()), true, 'Existing key readiness is independent of the enabled checkbox');
    assert.equal(await page.locator('#zkFileOperationsNotice').isVisible(), false);
    assert.equal(await page.locator('#rename').isEnabled(), true);
    page.once('dialog', dialog => dialog.accept('new-folder'));
    await page.locator('#rename').click();
    assert.equal((await requests(page, 1))[0].command, operations.rename);
});

for (const withKey of [false, true]) {
    test(`browsing, uploads, downloads, deletion, folder creation and favorites remain available ${withKey ? 'with key' : 'without key'}`, async t => {
        const page = await openClient(t);
        await setMode(page, true, withKey);
        await selectFiles(page, [file, folder]);
        await page.locator('#delete').click();
        await requests(page, 1);
        await page.locator('#addToFavorites').click();
        await requests(page, 2);
        await page.evaluate(() => { currentGroup = 'favorites'; updateButtonsStatus(); });
        assert.equal(await page.locator('#removeFromFavorites').isEnabled(), true);
        await page.locator('#removeFromFavorites').click();
        await requests(page, 3);
        // Real file-card handlers browse directories and download files.
        await page.locator('.fileItemBox').nth(1).click();
        await requests(page, 4);
        await page.locator('.fileItemBox').nth(0).click();
        await requests(page, 5);
        await page.evaluate(() => {
            setFile('upload.txt', 1, new TextEncoder().encode('synthetic upload').buffer, null, 123);
            onGetFavorites();
            createDir('source', 'new-folder');
        });
        const sent = await requests(page, 8);
        const commandIds = await page.evaluate(() => [command.Delete, command.AddToGroup, command.RemoveFromGroup, command.GetDir, command.GetFile, command.SetFile, command.GetGroup, command.CreateDir]);
        assert.deepEqual(sent.map(request => request.command).sort((a, b) => a - b), commandIds.sort((a, b) => a - b));
        assert.equal(await page.locator('#zkFileOperationsNotice').isVisible(), true);
        const layout = await page.evaluate(() => {
            const note = document.getElementById('zkFileOperationsNotice').getBoundingClientRect();
            const button = document.getElementById('delete').getBoundingClientRect();
            const toolbar = document.getElementById('bottom').getBoundingClientRect();
            return { noteAboveButtons: note.bottom <= button.top, noteInsideToolbar: note.right <= toolbar.right && note.bottom <= toolbar.bottom };
        });
        assert.deepEqual(layout, { noteAboveButtons: true, noteInsideToolbar: true });
        if (process.env.TEST_SCREENSHOT_PATH) await page.screenshot({ path: process.env.TEST_SCREENSHOT_PATH, fullPage: true });
    });
}

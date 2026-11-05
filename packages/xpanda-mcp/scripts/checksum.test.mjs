import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(root, 'packages/xpanda-core/package.json'));
const {zipSync, strToU8} = require('fflate');

test('MCP loads checksum-mismatched ABC and HAP entries with explicit diagnostics', {timeout: 15000}, async () => {
    const temp = await fs.mkdtemp(resolve(tmpdir(), 'xpanda-mcp-checksum-'));
    const client = new Client({name: 'checksum-regression', version: '1.0.0'});
    const transport = new StdioClientTransport({command: process.execPath, args: [
        '--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'),
        resolve(root, 'packages/xpanda-mcp/src/server.ts'),
    ], stderr: 'pipe'});
    try {
        const data = await fs.readFile(resolve(root, 'packages/xpanda-core/test/resources/class.abc'));
        data.fill(0, 8, 12);
        const abc = resolve(temp, 'sample.abc'), hap = resolve(temp, 'sample.hap');
        await fs.writeFile(abc, data);
        await fs.writeFile(hap, zipSync({'ets/modules.abc': data,
            'module.json': strToU8(JSON.stringify({module: {name: 'entry'}}))}));
        await client.connect(transport);
        const call = async (name, args) => {
            const result = await client.callTool({name, arguments: args});
            assert.notEqual(result.isError, true, JSON.stringify(result));
            return JSON.parse(result.content[0].text);
        };
        const loaded = await call('abc_load', {path: abc});
        assert.equal(loaded.checksumMismatch.expected, 0);
        assert.ok(loaded.classCount > 0);
        const packageSession = await call('abc_load', {path: hap});
        const entry = await call('hap_read_abc', {fileId: packageSession.fileId, entry: 'ets/modules.abc'});
        assert.deepEqual(entry.checksumMismatch, loaded.checksumMismatch);
        assert.equal(entry.classCount, loaded.classCount);
        const other = await fs.readFile(resolve(root, 'packages/xpanda-core/test/resources/md5.abc'));
        other.fill(0, 8, 12);
        await fs.mkdir(resolve(temp, 'other'));
        const otherPath = resolve(temp, 'other/sample.abc');
        await fs.writeFile(otherPath, other);
        const otherLoaded = await call('abc_load', {path: otherPath});
        assert.notEqual(otherLoaded.fileId, loaded.fileId, 'invalid header checksums must not alias different ABC sessions');
    } finally {
        await client.close();
        await fs.rm(temp, {recursive: true, force: true});
    }
});

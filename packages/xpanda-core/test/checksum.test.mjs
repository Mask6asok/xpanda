import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as core from '../src/index.ts';

const original = new Uint8Array(readFileSync(new URL('./resources/class.abc', import.meta.url)));
const damagedChecksum = () => {
    const data = original.slice();
    data.fill(0, 8, 12);
    return data;
};
const shape = file => file.getAllClasses().map(c => [c.name.content, [...c.pandaMethods.keys()]]);

test('strict parsing identifies checksum failures without calling them encryption', () => {
    assert.throws(() => new core.PandaFile(damagedChecksum()), error => {
        assert.equal(error.name, 'PandaChecksumException');
        assert.equal(error.expected, 0);
        assert.ok(error.calculated > 0);
        assert.doesNotMatch(error.message, /encrypt/i);
        return true;
    });
});

test('lenient analysis preserves original bytes and class/method identities', () => {
    const data = damagedChecksum(), before = data.slice();
    const strict = new core.PandaFile(original);
    const file = core.parsePandaFileForAnalysis(data);
    assert.deepEqual(shape(file), shape(strict));
    assert.equal(file.data, data);
    assert.deepEqual(data, before);
    assert.equal(file.checksumMismatch.expected, 0);
    assert.equal(file.checksumMismatch.calculated, strict.header.checksum);
    assert.deepEqual(shape(new core.PandaFile(data, {lenientChecksum: true})), shape(strict));
    assert.equal(core.parsePandaFileForAnalysis(original).checksumMismatch, undefined);
});

test('lenient analysis still rejects invalid magic, truncated data and corrupt index ranges', () => {
    const badMagic = damagedChecksum(); badMagic[0] = 0;
    assert.throws(() => core.parsePandaFileForAnalysis(badMagic), /magic/);
    assert.throws(() => core.parsePandaFileForAnalysis(damagedChecksum().subarray(0, 40)));
    const badIndex = damagedChecksum();
    new DataView(badIndex.buffer).setUint32(52, 0x0fffffff, true);
    assert.throws(() => core.parsePandaFileForAnalysis(badIndex), /bounds|range/i);
});

import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'node:test';
import { parseModuleList, resolveImagePath, symbolKind, toModule } from '../../src/adapter/modules';

const LMV = `start             end                 module name
00007ff6\`b0930000 00007ff6\`b094b000   sample   C (private pdb symbols)  d:\\src\\out\\sample.pdb
    Loaded symbol image file: sample.exe
    Image path: D:\\src\\out\\sample.exe
    Image name: sample.exe
    Timestamp:        6530A1B2 (Thu Oct 19 05:12:18 2023)
00007ffd\`be9a0000 00007ffd\`bec07000   ntdll      (export symbols)       C:\\windows\\SYSTEM32\\ntdll.dll
    Loaded symbol image file: C:\\windows\\SYSTEM32\\ntdll.dll
    Image path: ntdll.dll
    Image name: ntdll.dll
    Timestamp:        6BDF03CA (This is a reproducible build file hash, not a timestamp)
    File version:     10.0.26100.9444
`;

describe('modules', () => {
    it('parses lmv output by base address', () => {
        const map = parseModuleList(LMV);
        assert.deepStrictEqual(map.get('7ff6b0930000'), { shortName: 'sample', imagePath: 'D:\\src\\out\\sample.exe', timestamp: '6530A1B2 (Thu Oct 19 05:12:18 2023)' });
        assert.strictEqual(map.get('7ffdbe9a0000')!.version, '10.0.26100.9444');
        assert.strictEqual(map.get('7ffdbe9a0000')!.shortName, 'ntdll');
    });

    it('classifies symbol states', () => {
        assert.strictEqual(symbolKind('PDB (Private)'), 'pdb');
        assert.strictEqual(symbolKind('PDB (Public)'), 'pdb');
        assert.strictEqual(symbolKind('Deferred'), 'deferred');
        assert.strictEqual(symbolKind('Export'), 'export');
        assert.strictEqual(symbolKind('Export symbols'), 'export');
        assert.strictEqual(symbolKind(undefined), 'none');
    });

    it('resolves bare module names to full paths', () => {
        assert.strictEqual(resolveImagePath('C:\\x\\a.dll', undefined, undefined), 'C:\\x\\a.dll');
        assert.strictEqual(resolveImagePath('sample.exe', { shortName: 'sample', imagePath: 'D:\\o\\sample.exe' }, undefined), 'D:\\o\\sample.exe');
        assert.strictEqual(resolveImagePath('app.exe', { shortName: 'app', imagePath: 'app.exe' }, 'D:\\b\\App.exe'), 'D:\\b\\App.exe');
        const sys = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ntdll.dll');
        assert.strictEqual(resolveImagePath('ntdll.dll', { shortName: 'ntdll', imagePath: 'ntdll.dll' }, undefined).toLowerCase(), sys.toLowerCase());
    });

    it('builds DAP modules', () => {
        const m = toModule({ name: 'C:\\x\\Lib.dll', base: '7ff600000000', size: 0x2000, symType: 'PDB (Private)', symFile: 'C:\\x\\Lib.pdb' }, undefined, undefined, (n) => n === 'Lib');
        assert.strictEqual(m.name, 'Lib.dll');
        assert.strictEqual(m.shortName, 'Lib');
        assert.strictEqual(m.symbolKind, 'pdb');
        assert.strictEqual(m.symbolFilePath, 'C:\\x\\Lib.pdb');
        assert.strictEqual(m.isUserCode, true);
        assert.strictEqual(m.addressRange, '0x00007ff600000000-0x00007ff600002000');
        // For export symbols cdb reports the image itself as the symbol source: not a PDB.
        const e = toModule({ name: 'C:\\w\\ntdll.dll', base: '1000', size: 16, symType: 'Export', symFile: 'C:\\w\\ntdll.dll' }, undefined, undefined, () => false);
        assert.strictEqual(e.symbolFilePath, undefined);
        assert.strictEqual(e.symbolStatus, 'No PDB found (exports only)');
    });
});

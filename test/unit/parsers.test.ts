import * as assert from 'assert';
import { describe, it } from 'node:test';
import {
    executionCommand,
    hitConditionSatisfied,
    parseBreakpointList,
    parseDisassembly,
    parseExceptionRecord,
    parseFrameText,
    parseHitCondition,
    parseLastEvent,
    parseLnSourceLine,
    parseLogMessage,
    stripPrompts,
} from '../../src/adapter/parsers';
import { buildSourcePath, buildSymbolPath } from '../../src/adapter/symbols';

describe('cdb output parsers', () => {
    it('strips prompts', () => {
        assert.strictEqual(stripPrompts('0:000> Last event\n0:001:x86> foo'), 'Last event\nfoo');
    });

    it('parses .lastevent', () => {
        assert.deepStrictEqual(parseLastEvent('Last event: 3200.17a94: Hit breakpoint 1000\n  debugger time: x'), { kind: 'breakpoint', id: 1000, pid: 0x3200, tid: 0x17a94 });
        assert.deepStrictEqual(parseLastEvent('Last event: 18830.55e0: Exit process 0:18830, code 0'), { kind: 'exit', exitCode: 0 });
        assert.deepStrictEqual(parseLastEvent('Last event: <no event>'), { kind: 'none' });
        const ex = parseLastEvent('Last event: 18830.55e0: C++ EH exception - code e06d7363 (first chance)');
        assert.deepStrictEqual(ex, { kind: 'exception', code: 0xe06d7363, description: 'C++ EH exception', firstChance: true, pid: 0x18830, tid: 0x55e0 });
        const second = parseLastEvent('Last event: 1.2: Access violation - code c0000005 (!!! second chance !!!)');
        assert.strictEqual(second.kind, 'exception');
        assert.strictEqual(second.kind === 'exception' && second.firstChance, false);
        assert.deepStrictEqual(parseLastEvent('Last event: 1.2: Exit process 0:1, code c0000005'), { kind: 'exit', exitCode: 0xc0000005 | 0 });
    });

    it('parses exception records', () => {
        const rec = parseExceptionRecord(
            'ExceptionAddress: 00007ffdbbd241ca (KERNELBASE!RaiseException+0x8a)\n   ExceptionCode: e06d7363 (C++ EH exception)\n  ExceptionFlags: 00000081\nNumberParameters: 4\n   Parameter[0]: 0000000019930520\n   Parameter[1]: 000000ffbf76f7d0\n   Parameter[2]: 00007ff7b6183360\n   Parameter[3]: 00007ff7b6170000',
        );
        assert.strictEqual(rec.code, 0xe06d7363);
        assert.deepStrictEqual(rec.params, ['0000000019930520', '000000ffbf76f7d0', '00007ff7b6183360', '00007ff7b6170000']);
    });

    it('parses breakpoint lists', () => {
        const map = parseBreakpointList(
            ' 1000 e 00007ff6`96f421a4 [D:\\src\\sample.cpp @ 56]    0001 (0001)  0:**** sample!app::compute+0x84\n' +
                ' 1001 eu                      0001 (0001) (`nosuchfile.cpp:12`)\n' +
                ' 1002 d 00007ff6`96f42120     0001 (0001)  0:**** sample!app::compute',
        );
        assert.deepStrictEqual(map.get(1000), { id: 1000, enabled: true, unresolved: false, address: '00007ff696f421a4', file: 'D:\\src\\sample.cpp', line: 56, symbol: 'sample!app::compute+0x84' });
        assert.strictEqual(map.get(1001)!.unresolved, true);
        assert.strictEqual(map.get(1002)!.enabled, false);
    });

    it('parses ln source lines', () => {
        assert.deepStrictEqual(parseLnSourceLine('D:\\src\\sample.cpp(35)\n(00007ff7`b61720f0)   sample!app::compute+0x82'), { file: 'D:\\src\\sample.cpp', line: 35 });
    });

    it('parses disassembly with symbol headers', () => {
        const lines = parseDisassembly(
            'sample!app::compute+0x84 [D:\\src\\sample.cpp @ 56]:\n00007ff6`96f421a4 8b442420        mov     eax,dword ptr [rsp+20h]\n00007ff6`96f421a8 4883c458        add     rsp,58h',
        );
        assert.strictEqual(lines.length, 2);
        assert.deepStrictEqual(lines[0], { address: '00007ff696f421a4', bytes: '8b442420', text: 'mov eax,dword ptr [rsp+20h]', symbol: 'sample!app::compute+0x84', file: 'D:\\src\\sample.cpp', line: 56 });
        assert.strictEqual(lines[1].symbol, undefined);
    });

    it('parses frame text', () => {
        assert.deepStrictEqual(parseFrameText('sample!app::compute + 0x82'), { module: 'sample', fn: 'app::compute', offset: '0x82' });
        assert.deepStrictEqual(parseFrameText('ntdll!RtlUserThreadStart'), { module: 'ntdll', fn: 'RtlUserThreadStart', offset: undefined });
    });

    it('parses hit conditions', () => {
        assert.deepStrictEqual(parseHitCondition('5'), { op: '==', value: 5 });
        assert.deepStrictEqual(parseHitCondition('>= 3'), { op: '>=', value: 3 });
        assert.deepStrictEqual(parseHitCondition('%2'), { op: '%', value: 2 });
        assert.strictEqual(parseHitCondition('abc'), undefined);
        assert.ok(hitConditionSatisfied({ op: '%', value: 2 }, 4));
        assert.ok(!hitConditionSatisfied({ op: '%', value: 2 }, 3));
        assert.ok(hitConditionSatisfied({ op: '>', value: 2 }, 3));
    });

    it('splits logpoint messages', () => {
        assert.deepStrictEqual(parseLogMessage('x={x} {{literal}} y={p->y}'), [{ text: 'x=' }, { expr: 'x' }, { text: ' {literal} y=' }, { expr: 'p->y' }]);
        assert.deepStrictEqual(parseLogMessage('$FUNCTION entered'), [{ text: '$FUNCTION entered' }]);
    });

    it('classifies execution commands', () => {
        assert.strictEqual(executionCommand('g'), 'continue');
        assert.strictEqual(executionCommand('gu'), 'stepOut');
        assert.strictEqual(executionCommand('p'), 'next');
        assert.strictEqual(executionCommand('t'), 'stepIn');
        assert.strictEqual(executionCommand('qd'), 'quit');
        assert.strictEqual(executionCommand('pc'), 'unsupported');
        assert.strictEqual(executionCommand('k'), undefined);
        assert.strictEqual(executionCommand('dx p'), undefined);
    });
});

describe('symbol paths', () => {
    it('puts local directories first and caches servers', () => {
        const p = buildSymbolPath({ cachePath: 'C:\\sym', searchPaths: ['D:\\build'], servers: ['https://symbols.example.com'] }, 'D:\\out', {});
        assert.strictEqual(p, 'D:\\out;D:\\build;srv*C:\\sym*https://symbols.example.com;srv*C:\\sym*https://msdl.microsoft.com/download/symbols');
    });

    it('can omit the Microsoft server and inherit _NT_SYMBOL_PATH', () => {
        const p = buildSymbolPath({ cachePath: 'C:\\sym', useMicrosoftSymbolServer: false }, undefined, { _NT_SYMBOL_PATH: 'srv*E:\\x*https://a' });
        assert.strictEqual(p, 'cache*C:\\sym;srv*E:\\x*https://a');
    });

    it('builds source paths', () => {
        assert.strictEqual(buildSourcePath(['D:\\src'], true), 'srv*;D:\\src');
        assert.strictEqual(buildSourcePath([], false), undefined);
    });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { JustMyCode, stripTemplateArgs } from '../../src/adapter/jmc';
import { wildcardMatch } from '../../src/adapter/glob';

const src = 'D:\\proj\\src\\main.cpp';

describe('wildcards', () => {
    it('matches * across separators and ? as one character', () => {
        assert.ok(wildcardMatch('std::*', 'std::vector<int>::push_back'));
        assert.ok(wildcardMatch('a?c', 'abc'));
        assert.ok(!wildcardMatch('a?c', 'abbc'));
        assert.ok(wildcardMatch('*.cpp', 'X.CPP', true));
        assert.ok(!wildcardMatch('*.cpp', 'X.CPP', false));
    });
});

describe('Just My Code rules', () => {
    it('strips template arguments', () => {
        assert.strictEqual(stripTemplateArgs('std::vector<std::pair<int,int> >::push_back'), 'std::vector::push_back');
    });

    it('treats namespaces, classes and functions as scope prefixes', () => {
        const jmc = new JustMyCode(true, undefined, 'D:\\proj', { inheritDefaults: false, external: { symbols: ['boost', 'app::Detail', 'app::helper'] } });
        assert.ok(!jmc.isUserCode({ fn: 'boost::asio::run', file: src }));
        assert.ok(!jmc.isUserCode({ fn: 'app::Detail::Impl::go', file: src }));
        assert.ok(!jmc.isUserCode({ fn: 'app::helper', file: src }));
        assert.ok(jmc.isUserCode({ fn: 'app::helperX', file: src }));
        assert.ok(jmc.isUserCode({ fn: 'boostx::run', file: src }));
    });

    it('matches template classes with or without arguments', () => {
        const jmc = new JustMyCode(true, undefined, undefined, { inheritDefaults: false, external: { symbols: ['lib::Vec', 'other::Map::find'] } });
        assert.ok(!jmc.isUserCode({ fn: 'lib::Vec<int>::size', file: src }));
        assert.ok(!jmc.isUserCode({ fn: 'other::Map<int,std::string>::find', file: src }));
    });

    it('supports wildcards and module-qualified symbols', () => {
        const jmc = new JustMyCode(true, undefined, undefined, { inheritDefaults: false, external: { symbols: ['Qt*', 'mylib!*'] } });
        assert.ok(!jmc.isUserCode({ fn: 'QtPrivate::foo', file: src }));
        assert.ok(!jmc.isUserCode({ fn: 'anything', module: 'MyLib.dll', file: src }));
        assert.ok(jmc.isUserCode({ fn: 'anything', module: 'app.exe', file: src }));
    });

    it('matches file paths by prefix, suffix and wildcard', () => {
        const jmc = new JustMyCode(true, undefined, 'D:\\proj', {
            inheritDefaults: false,
            external: { files: ['C:\\Program Files', 'third_party', '${workspaceFolder}/generated/*.cpp', '*_moc.cpp'] },
        });
        assert.ok(!jmc.isUserCode({ fn: 'f', file: 'C:\\Program Files\\Lib\\x.h' }));
        assert.ok(jmc.isUserCode({ fn: 'f', file: 'C:\\Program Files (x86)\\x.h' }));
        assert.ok(!jmc.isUserCode({ fn: 'f', file: 'D:\\proj\\third_party\\zlib\\inflate.c' }));
        assert.ok(!jmc.isUserCode({ fn: 'f', file: 'd:/PROJ/generated/a.cpp' }));
        assert.ok(!jmc.isUserCode({ fn: 'f', file: 'D:\\proj\\src\\window_moc.cpp' }));
        assert.ok(jmc.isUserCode({ fn: 'f', file: 'D:\\proj\\src\\window.cpp' }));
    });

    it('lets user rules override external ones', () => {
        const jmc = new JustMyCode(true, undefined, undefined, { external: { symbols: ['lib'] }, user: { symbols: ['lib::Callbacks'] } });
        assert.ok(!jmc.isUserCode({ fn: 'lib::run', file: src }));
        assert.ok(jmc.isUserCode({ fn: 'lib::Callbacks::onEvent', file: src }));
    });

    it('applies the built-in defaults and treats code without source as external', () => {
        const jmc = new JustMyCode(true, undefined, undefined, {});
        assert.ok(!jmc.isUserCode({ fn: 'std::vector<int>::push_back', file: src }));
        assert.ok(!jmc.isUserCode({ fn: 'invoke_main', file: 'D:\\a\\_work\\1\\s\\src\\vctools\\crt\\vcstartup\\src\\startup\\exe_common.inl' }));
        assert.ok(!jmc.isUserCode({ fn: 'RtlUserThreadStart', module: 'ntdll.dll' }));
        assert.ok(jmc.isUserCode({ fn: 'app::compute', module: 'sample.exe', file: src }));
        assert.ok(new JustMyCode(false, undefined, undefined, {}).isUserCode({ fn: 'std::sort' }));
    });

    it('reloads the configuration file when it changes', () => {
        const file = path.join(os.tmpdir(), `jmc-${process.pid}.json`);
        fs.writeFileSync(file, '{ // comment\n "external": { "symbols": ["app::a"] }, }');
        try {
            const jmc = new JustMyCode(true, file, undefined);
            assert.strictEqual(jmc.lastError, undefined);
            assert.ok(!jmc.isUserCode({ fn: 'app::a', file: src }));
            fs.writeFileSync(file, '{ "external": { "symbols": ["app::b"] } }');
            const later = new Date(Date.now() + 5000);
            fs.utimesSync(file, later, later);
            jmc.reloadIfChanged();
            assert.ok(jmc.isUserCode({ fn: 'app::a', file: src }));
            assert.ok(!jmc.isUserCode({ fn: 'app::b', file: src }));
        } finally {
            fs.rmSync(file, { force: true });
        }
    });
});

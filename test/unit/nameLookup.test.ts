import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, it } from 'node:test';

// The debugger script runs inside cdb; its parsing helpers need no host and run here as is.
const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'dbgscript', 'vscode_windbg.js');
const script = vm.createContext({});
vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), script);

type Lookup = (parts: string[], next: { s: string } | undefined, module: string | undefined) => { text: string; value?: unknown } | undefined;
const rewriteNames = script.rewriteNames as (expr: string, lookup: Lookup) => { expr: string; value?: unknown };
const checkSideEffects = script.checkSideEffects as (toks: unknown[]) => void;
const scanTokens = script.scanTokens as (expr: string) => unknown[];
const scriptScopes = script.enclosingScopes as (fn: string) => string[];
// Arrays made in the script's context have another Array prototype: copy them for deepStrictEqual.
const enclosingScopes = (fn: string) => Array.from(scriptScopes(fn));

/** A frame with locals `p`, `i` and members `m_x`, `count`. Records what was looked up. */
function frame(): { lookup: Lookup; asked: string[] } {
    const asked: string[] = [];
    const lookup: Lookup = (parts, _next, module) => {
        const name = (module ? `${module}!` : '') + parts.join('::');
        asked.push(name);
        if (!module && parts.length === 1 && ['p', 'i'].includes(parts[0])) {
            return undefined;
        }
        if (!module && parts.length === 1 && ['m_x', 'count'].includes(parts[0])) {
            return { text: `this->${parts[0]}` };
        }
        return { text: `<${name}>`, value: name };
    };
    return { lookup, asked };
}

describe('hover and watch name lookup', () => {
    it('rewrites members of this and leaves locals alone', () => {
        const f = frame();
        assert.strictEqual(rewriteNames('m_x', f.lookup).expr, 'this->m_x');
        assert.strictEqual(rewriteNames('p->count + m_x * i', f.lookup).expr, 'p->count + this->m_x * i');
        assert.deepStrictEqual(f.asked, ['m_x', 'p', 'm_x', 'i']);
    });

    it('does not look up member names, keywords or literals', () => {
        const f = frame();
        assert.strictEqual(rewriteNames('p.count == L"m_x" && this->count != \'c\'', f.lookup).expr, 'p.count == L"m_x" && this->count != \'c\'');
        assert.strictEqual(rewriteNames('0x10ull + 1e5 + 0n10', f.lookup).expr, '0x10ull + 1e5 + 0n10');
        assert.deepStrictEqual(f.asked, ['p']);
    });

    it('looks registers and pseudo-variables up', () => {
        const f = frame();
        assert.strictEqual(rewriteNames('(char*)$rdi + @rax', f.lookup).expr, '(char*)<$rdi> + <@rax>');
        assert.strictEqual(rewriteNames('$tid', f.lookup).value, '$tid');
        assert.deepStrictEqual(f.asked, ['$rdi', '@rax', '$tid']);
    });

    it('does not look up type names of casts and sizeof', () => {
        const f = frame();
        rewriteNames('(Foo *)p', f.lookup);
        rewriteNames('(Foo)i', f.lookup);
        rewriteNames('sizeof(Foo)', f.lookup);
        rewriteNames('static_cast<ns::Foo const *>(p)', f.lookup);
        assert.deepStrictEqual(f.asked, ['p', 'i', 'p']);
        // A name in parentheses followed by an operator is a value.
        assert.strictEqual(rewriteNames('(m_x) * 2', f.lookup).expr, '(this->m_x) * 2');
    });

    it('looks qualified names and module-qualified names up as one name', () => {
        const f = frame();
        assert.strictEqual(rewriteNames('app::Color::Red', f.lookup).expr, '<app::Color::Red>');
        assert.strictEqual(rewriteNames('plugin!app::g_count + 1', f.lookup).expr, '<plugin!app::g_count> + 1');
        assert.deepStrictEqual(f.asked, ['app::Color::Red', 'plugin!app::g_count']);
        // "!=" and "!x" are operators, not module qualifiers.
        assert.strictEqual(rewriteNames('i != !p', f.lookup).expr, 'i != !p');
    });

    it("turns Visual Studio's context operator into a module-qualified name", () => {
        const f = frame();
        rewriteNames('{,,Qt6Cored.dll}qt_global', f.lookup);
        rewriteNames('{ , , "plugin.dll" }ns::value', f.lookup);
        assert.deepStrictEqual(f.asked, ['Qt6Cored!qt_global', 'plugin!ns::value']);
    });

    it('returns the value when the whole expression is one name', () => {
        const f = frame();
        assert.strictEqual(rewriteNames('g_limit', f.lookup).value, 'g_limit');
        assert.strictEqual(rewriteNames('g_limit + 1', f.lookup).value, undefined);
        assert.strictEqual(rewriteNames('m_x', f.lookup).value, undefined);
    });

    it('passes data model expressions through', () => {
        const f = frame();
        assert.strictEqual(rewriteNames('@$curprocess.Modules.Select(m => m.Name)', f.lookup).expr, '@$curprocess.Modules.Select(m => m.Name)');
        assert.strictEqual(rewriteNames('Debugger.Sessions', f.lookup).expr, 'Debugger.Sessions');
        assert.deepStrictEqual(f.asked, []);
    });

    it('refuses hovers with side effects', () => {
        for (const e of ['f(1)', 'p->get()', 'i = 2', 'i += 2', 'i++', '--i']) {
            assert.throws(() => checkSideEffects(scanTokens(e)), /side effects/, e);
        }
        for (const e of ['i == 2', 'i <= 2', 'sizeof(int)', '(int)i', 'static_cast<int>(i)', 'a[i]', 'p->m_x']) {
            checkSideEffects(scanTokens(e));
        }
    });

    it('lists the scopes enclosing a function, innermost first', () => {
        assert.deepStrictEqual(enclosingScopes('lib::SharedPtr<lib::ui::IWidget>::operator->'), ['lib::SharedPtr<lib::ui::IWidget>', 'lib']);
        assert.deepStrictEqual(enclosingScopes('app::Counter::bump'), ['app::Counter', 'app']);
        assert.deepStrictEqual(enclosingScopes('main'), []);
        assert.deepStrictEqual(enclosingScopes('app::run::<lambda_1>::operator()'), ['app::run', 'app']);
        assert.deepStrictEqual(enclosingScopes("`anonymous namespace'::helper"), []);
    });
});

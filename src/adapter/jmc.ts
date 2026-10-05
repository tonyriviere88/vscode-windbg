import * as fs from 'fs';
import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import { hasWildcard, wildcardToRegExp } from './glob';

/**
 * Just My Code rules.
 *
 * The configuration file (JSON with comments) looks like:
 *
 *   {
 *     "inheritDefaults": true,
 *     "external": {
 *       "symbols": ["std", "boost::*", "MyLib::Detail"],
 *       "files":   ["C:/Program Files*", "third_party/*"],
 *       "modules": ["Qt6*"]
 *     },
 *     "user": { "symbols": [], "files": [], "modules": [] }
 *   }
 *
 * "external" marks code as non-user; "user" entries win over "external" ones.
 */
export interface RuleSet {
    symbols?: string[];
    files?: string[];
    modules?: string[];
}

export interface JmcConfig {
    inheritDefaults?: boolean;
    external?: RuleSet;
    user?: RuleSet;
}

export const DEFAULT_EXTERNAL: Required<RuleSet> = {
    symbols: [
        'std',
        'stdext',
        'Concurrency',
        'concurrency',
        'invoke_main',
        'mainCRTStartup',
        'wmainCRTStartup',
        'WinMainCRTStartup',
        'wWinMainCRTStartup',
        '__scrt_*',
        '__acrt_*',
        '__vcrt_*',
        '__security_*',
        '_RTC_*',
        '__GSHandlerCheck*',
        '__CxxFrameHandler*',
        '_CxxThrowException',
        '__std_*',
        '_guard_*',
        'operator new',
        'operator delete',
    ],
    files: [
        '*/vctools/crt/*',
        '*/Microsoft Visual Studio/*/VC/Tools/MSVC/*',
        '*/Windows Kits/*',
        '*/minkernel/*',
        '*/onecore/*',
        '*/shared/inc/*',
    ],
    modules: [
        'ntdll',
        'kernel32',
        'kernelbase',
        'ucrtbase*',
        'msvcp*',
        'vcruntime*',
        'concrt*',
        'user32',
        'win32u',
        'gdi32*',
        'combase',
        'rpcrt4',
        'ole32',
        'oleaut32',
        'advapi32',
        'sechost',
        'msvcrt',
    ],
};

interface CompiledSymbolRule {
    exact?: string;
    regex?: RegExp;
    withModule: boolean;
}

interface CompiledFileRule {
    prefix?: string;
    suffix?: string;
    regex?: RegExp;
}

interface CompiledRules {
    symbols: CompiledSymbolRule[];
    files: CompiledFileRule[];
    modules: RegExp[];
}

export interface CodeLocation {
    /** Function name without module, e.g. "app::Shape::area". */
    fn?: string;
    /** Module base name, e.g. "sample" (extension optional). */
    module?: string;
    /** Source file path, if any. */
    file?: string;
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function isAbsolutePattern(p: string): boolean {
    return /^[a-z]:\//i.test(p) || p.startsWith('/');
}

/** Removes template argument lists: "std::vector<int>::push_back" -> "std::vector::push_back". */
export function stripTemplateArgs(name: string): string {
    let out = '';
    let depth = 0;
    for (const ch of name) {
        if (ch === '<') {
            depth++;
        } else if (ch === '>') {
            if (depth > 0) {
                depth--;
            }
        } else if (depth === 0) {
            out += ch;
        }
    }
    return out;
}

export function moduleBaseName(module: string): string {
    const base = module.replace(/^.*[\\/]/, '');
    return base.replace(/\.(dll|exe|sys|drv|ocx|cpl|pyd)$/i, '');
}

function compileSymbol(rule: string): CompiledSymbolRule {
    const withModule = rule.includes('!');
    if (hasWildcard(rule)) {
        return { regex: wildcardToRegExp(rule, withModule), withModule };
    }
    return { exact: rule, withModule };
}

function compileFile(rule: string, workspaceFolder: string | undefined): CompiledFileRule {
    let r = rule.trim();
    if (workspaceFolder) {
        r = r.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
    }
    r = normalizePath(r);
    if (hasWildcard(r)) {
        if (!isAbsolutePattern(r) && !r.startsWith('*')) {
            r = '*/' + r;
        }
        return { regex: wildcardToRegExp(r, true) };
    }
    if (isAbsolutePattern(r)) {
        return { prefix: r.replace(/\/$/, '') };
    }
    return { suffix: r.replace(/\/$/, '') };
}

function compile(rules: RuleSet, workspaceFolder: string | undefined): CompiledRules {
    return {
        symbols: (rules.symbols ?? []).filter((s) => s.trim()).map((s) => compileSymbol(s.trim())),
        files: (rules.files ?? []).filter((s) => s.trim()).map((s) => compileFile(s, workspaceFolder)),
        modules: (rules.modules ?? []).filter((s) => s.trim()).map((s) => wildcardToRegExp(moduleBaseName(s.trim()), true)),
    };
}

function symbolMatches(rule: CompiledSymbolRule, fn: string, module: string | undefined): boolean {
    const candidates = rule.withModule ? (module ? [`${module}!${fn}`, `${module}!${stripTemplateArgs(fn)}`] : []) : [fn, stripTemplateArgs(fn)];
    for (const c of candidates) {
        if (rule.regex) {
            if (rule.regex.test(c)) {
                return true;
            }
            continue;
        }
        const e = rule.exact!;
        const cmp = rule.withModule ? c.toLowerCase() : c;
        const ex = rule.withModule ? e.toLowerCase() : e;
        if (cmp === ex || cmp.startsWith(ex + '::') || cmp.startsWith(ex + '<')) {
            return true;
        }
    }
    return false;
}

function fileMatches(rule: CompiledFileRule, file: string): boolean {
    if (rule.regex) {
        return rule.regex.test(file);
    }
    if (rule.prefix !== undefined) {
        return file === rule.prefix || file.startsWith(rule.prefix + '/');
    }
    const s = rule.suffix!;
    return file === s || file.endsWith('/' + s) || file.includes('/' + s + '/') || file.startsWith(s + '/');
}

function matches(rules: CompiledRules, loc: CodeLocation): boolean {
    const module = loc.module ? moduleBaseName(loc.module).toLowerCase() : undefined;
    if (loc.fn && rules.symbols.some((r) => symbolMatches(r, loc.fn!, module))) {
        return true;
    }
    if (loc.file) {
        const f = normalizePath(loc.file);
        if (rules.files.some((r) => fileMatches(r, f))) {
            return true;
        }
    }
    if (module && rules.modules.some((r) => r.test(module))) {
        return true;
    }
    return false;
}

export class JustMyCode {
    private external: CompiledRules;
    private user: CompiledRules;
    private loadedMtime = -1;
    private cache = new Map<string, boolean>();
    public lastError: string | undefined;

    constructor(
        public enabled: boolean,
        private readonly configFile: string | undefined,
        private readonly workspaceFolder: string | undefined,
        config?: JmcConfig,
    ) {
        this.external = compile(DEFAULT_EXTERNAL, workspaceFolder);
        this.user = compile({}, workspaceFolder);
        if (config) {
            this.apply(config);
        } else {
            this.reloadIfChanged();
        }
    }

    /** Re-reads the configuration file when it changed on disk; cheap to call on every stop. */
    reloadIfChanged(): void {
        if (!this.configFile) {
            return;
        }
        let mtime = 0;
        try {
            mtime = fs.statSync(this.configFile).mtimeMs;
        } catch {
            mtime = 0;
        }
        if (mtime === this.loadedMtime) {
            return;
        }
        this.loadedMtime = mtime;
        if (mtime === 0) {
            this.apply({});
            return;
        }
        try {
            const errors: jsonc.ParseError[] = [];
            const parsed = jsonc.parse(fs.readFileSync(this.configFile, 'utf8'), errors, { allowTrailingComma: true });
            if (errors.length > 0) {
                this.lastError = `${path.basename(this.configFile)}: ${jsonc.printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`;
            } else {
                this.lastError = undefined;
            }
            this.apply((parsed ?? {}) as JmcConfig);
        } catch (e) {
            this.lastError = `${this.configFile}: ${(e as Error).message}`;
            this.apply({});
        }
    }

    private apply(config: JmcConfig): void {
        const inherit = config.inheritDefaults !== false;
        const ext = config.external ?? {};
        this.external = compile(
            {
                symbols: [...(inherit ? DEFAULT_EXTERNAL.symbols : []), ...(ext.symbols ?? [])],
                files: [...(inherit ? DEFAULT_EXTERNAL.files : []), ...(ext.files ?? [])],
                modules: [...(inherit ? DEFAULT_EXTERNAL.modules : []), ...(ext.modules ?? [])],
            },
            this.workspaceFolder,
        );
        this.user = compile(config.user ?? {}, this.workspaceFolder);
        this.cache.clear();
    }

    /** True when no module rule makes the module external. */
    isUserModule(module: string): boolean {
        if (!this.enabled) {
            return true;
        }
        return matches(this.user, { module }) || !matches(this.external, { module });
    }

    /** True when the location is user code. Code without source information is never user code. */
    isUserCode(loc: CodeLocation): boolean {
        if (!this.enabled) {
            return true;
        }
        if (!loc.file) {
            return false;
        }
        const key = `${loc.module ?? ''}|${loc.fn ?? ''}|${loc.file}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const result = matches(this.user, loc) || !matches(this.external, loc);
        this.cache.set(key, result);
        return result;
    }
}

export const JMC_TEMPLATE = `{
    // Just My Code rules for the WinDbg debugger.
    // Code is "external" when its function, source file or module matches an
    // "external" rule and no "user" rule. External code is skipped by stepping
    // and collapsed into [External Code] in the call stack.
    //
    // symbols: namespaces, classes or functions. "std" matches std::* and
    //          std<...>; '*' and '?' are wildcards; "module!pattern" also
    //          checks the module.
    // files:   absolute paths or directories (prefix match), relative paths
    //          (matched anywhere), or wildcard patterns.
    // modules: module names without extension, wildcards allowed.
    "inheritDefaults": true,
    "external": {
        "symbols": [],
        "files": [],
        "modules": []
    },
    "user": {
        "symbols": [],
        "files": [],
        "modules": []
    }
}
`;

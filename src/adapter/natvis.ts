/**
 * Natvis expressions naming another module ("RshGeometry.dll!rsh::GCloud") make dbgeng load that
 * module's symbols when a value is shown. To show values without loading anything, the natvis
 * loaded in cdb names the modules whose symbols are deferred by a module that does not exist: the
 * expression fails at once, and the visualizer falls back (another DisplayString, the raw value).
 */

/** "module!", "module.dll!" or "module.exe!" before a name. */
const MODULE_REF = /\b([A-Za-z_]\w*)(?:\.(?:dll|exe))?!(?=[A-Za-z_:~])/gi;
/** Type names are matched, not evaluated: a module prefix there is left alone. */
const TYPE_TAG = /<(?:Type|AlternativeType)\b[^>]*>/g;

/** Applies f to the parts of a natvis file that hold expressions (all but the Type tags). */
function mapExpressions(text: string, f: (part: string) => string): string {
    let out = '';
    let pos = 0;
    for (const m of text.matchAll(TYPE_TAG)) {
        out += f(text.slice(pos, m.index)) + m[0];
        pos = m.index! + m[0].length;
    }
    return out + f(text.slice(pos));
}

/** The modules (lower case, without extension) the expressions of a natvis file name. */
export function natvisModuleRefs(text: string): Set<string> {
    const refs = new Set<string>();
    mapExpressions(text, (part) => {
        for (const m of part.matchAll(MODULE_REF)) {
            refs.add(m[1].toLowerCase());
        }
        return part;
    });
    return refs;
}

/** The module name standing for `module` while its symbols are deferred. */
export function unloadedModuleName(module: string): string {
    return `${module}_symbols_not_loaded`;
}

/** The natvis text with the modules of `deferred` (lower case) renamed to modules that do not exist. */
export function neutralizeNatvis(text: string, deferred: ReadonlySet<string>): string {
    return mapExpressions(text, (part) => part.replace(MODULE_REF, (ref, module: string) => (deferred.has(module.toLowerCase()) ? `${unloadedModuleName(module)}!` : ref)));
}

/**
 * True when the AutoVisualizer node of a natvis file holds no element (comments aside): cdb
 * refuses such a file with "Unexpected empty 'AutoVisualizer' node".
 */
export function isEmptyNatvis(text: string): boolean {
    const xml = text.replace(/<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)/g, '');
    const open = /<AutoVisualizer\b[^>]*?(\/?)>/.exec(xml);
    if (!open) {
        return false;
    }
    const content = xml.slice(open.index + open[0].length).split(/<\/AutoVisualizer\s*>/)[0];
    return open[1] === '/' || !/<[A-Za-z_]/.test(content);
}

"use strict";

// Data-model bridge loaded into cdb by the VS Code WinDbg adapter.
//
// The adapter calls `!vscwdbg "<hex>"`, where <hex> is a UTF-8 JSON request
// encoded as hexadecimal (so no escaping is ever needed on the command line).
// Every call prints a JSON response whose non-ASCII characters are escaped,
// which keeps it intact through cdb's ANSI output pipe. debugLog truncates a
// single call at 16383 characters, so the response is printed as CHUNK lines
// (MARK_PART + piece) followed by one MARK_END line.

const MARK_PART = "@@WDBGJSON+@@";
const MARK_END = "@@WDBGJSON.@@";
const CHUNK_SIZE = 8000;
const MAX_ITEMS = 5000;
const MAX_SUMMARY_FIELDS = 6;
const MAX_DISPLAY_STRING = 1024;
const MAX_VIEW_STRING = 16 * 1024 * 1024;

// Properties every data model object exposes; never user data.
const META = new Set([
    "toString", "addParentModel", "removeParentModel", "getDimensionality", "getValueAt", "setValueAt",
    "hostContext", "targetSize", "targetType", "targetLocation", "runtimeTypedObject", "ToDisplayString",
    "dereference", "add", "compareTo", "address", "isNull", "constructor", "Attributes"
]);

const CHAR_TYPE = /^(const |volatile )*(unsigned |signed )?(char|wchar_t|char8_t|char16_t|char32_t)( const| volatile)*$/;

let handles = new Map();
let nextHandle = 1;
let rawMemberCache = new Map();
let frameScopes = new Map();
// Set while a hover is evaluated or expanded: nothing may load symbols then. What would need
// symbols is collected in symbolHints instead.
let noLoad = false;
let symbolHints = [];
// Modules of the process during a noLoad call (see moduleTable).
let noLoadModules;

// ---------------------------------------------------------------- utilities

function safe(f, fallback) {
    try { return f(); } catch (e) { return fallback; }
}

function errMsg(e) {
    if (e === undefined || e === null) return "unknown error";
    if (typeof e === "string") return e;
    return e.message || String(e);
}

function decodeHex(hex) {
    let pct = "";
    for (let i = 0; i < hex.length; i += 2) pct += "%" + hex.substr(i, 2);
    return decodeURIComponent(pct);
}

function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[\u007f-￿]/g, c => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
}

function isInt64(v) {
    return v !== null && typeof v === "object" && typeof v.asNumber === "function" && typeof v.compareTo === "function" && v.targetType === undefined;
}

function num(v) {
    if (typeof v === "number") return v;
    if (isInt64(v)) return v.asNumber();
    return Number(v);
}

function hexOf(v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "number") return v.toString(16);
    if (isInt64(v)) return v.toString(16);
    // Location objects stringify as "0x...".
    let s = String(v);
    return s.replace(/^0x/i, "");
}

function int64(hex) {
    return host.parseInt64(String(hex).replace(/^0x/i, "").replace(/`/g, ""), 16);
}

function quote(s) {
    let out = "\"";
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        let ch = s[i];
        if (ch === "\"") out += "\\\"";
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (c < 32) out += "\\x" + ("0" + c.toString(16)).slice(-2);
        else out += ch;
    }
    return out + "\"";
}

function typeOf(v) {
    return safe(() => v.targetType, undefined);
}

function typeName(t) {
    if (!t) return undefined;
    if (typeof t === "string") return t;
    return safe(() => String(t.name), undefined);
}

function typeKind(t) {
    return safe(() => String(t.typeKind), undefined);
}

function isCharType(t) {
    let n = typeName(t);
    return n !== undefined && CHAR_TYPE.test(n);
}

function charSize(t) {
    let n = typeName(t) || "";
    if (/wchar_t|char16_t/.test(n)) return 2;
    if (/char32_t/.test(n)) return 4;
    return 1;
}

function propNames(o) {
    return safe(() => Object.getOwnPropertyNames(o), []);
}

function isIterable(o) {
    return safe(() => o !== null && typeof o === "object" && typeof o[Symbol.iterator] === "function", false);
}

function isReference(t) {
    let pk = safe(() => String(t.pointerKind), "");
    return pk.indexOf("reference") >= 0 || pk === "&" || pk === "&&";
}

// References behave like the object they refer to.
function normalize(v) {
    let t = typeOf(v);
    if (t && typeKind(t) === "pointer" && isReference(t)) {
        return runtimeTyped(safe(() => v.dereference(), v));
    }
    return v;
}

function runtimeTyped(v) {
    let t = typeOf(v);
    if (t && typeKind(t) === "udt") {
        if (noLoad) {
            // runtimeTypedObject looks the vtable up in the symbols of its module, loading them.
            let dyn = safe(() => dynamicType(v), undefined);
            if (!dyn) return v;
            if (dyn.module.deferred) return dynamicWithoutLoad(v, dyn);
        }
        let r = safe(() => v.runtimeTypedObject, undefined);
        if (r !== undefined && r !== null) return r;
    }
    return v;
}

function addressOf(v) {
    let t = typeOf(v);
    if (!t) return undefined;
    if (typeKind(t) === "pointer" && !isReference(t)) {
        // The pointer variable itself, not the pointee.
        return safe(() => hexOf(v.targetLocation), undefined);
    }
    return safe(() => hexOf(v.targetLocation), undefined);
}

function ptrSize() {
    return safe(() => host.currentProcess.Attributes.Machine === "x86" ? 4 : 8, 8);
}

function pad(hex, digits) {
    while (hex.length < digits) hex = "0" + hex;
    return hex;
}

// ------------------------------------------------------------ thread/frames

function findThread(tid) {
    if (tid === undefined || tid === null) return host.currentThread;
    for (let t of host.currentProcess.Threads) {
        if (num(t.Id) === tid) return t;
    }
    throw new Error("Thread " + tid + " not found");
}

function frameAt(thread, index) {
    let i = 0;
    for (let f of thread.Stack.Frames) {
        if (i === index) return f;
        i++;
    }
    throw new Error("Frame " + index + " not found");
}

function ensureContext(tid, frame) {
    if (tid === undefined || tid === null) return;
    let th = findThread(tid);
    if (num(host.currentThread.Id) !== tid) th.SwitchTo();
    frameAt(th, frame || 0).SwitchTo();
}

function frameInfo(f, i) {
    let r = { i: i };
    r.text = safe(() => String(f), "");
    let a = safe(() => f.Attributes, undefined);
    if (a) {
        r.ip = safe(() => hexOf(a.InstructionOffset), undefined);
        r.sp = safe(() => hexOf(a.StackOffset), undefined);
        r.inl = safe(() => !!a.IsInlineFrame, false);
        let si = safe(() => a.SourceInformation, undefined);
        if (si) {
            r.fn = safe(() => si.FunctionName === undefined ? undefined : String(si.FunctionName), undefined);
            r.file = safe(() => si.SourceFile === undefined ? undefined : String(si.SourceFile), undefined);
            r.line = safe(() => si.SourceLine === undefined ? undefined : num(si.SourceLine), undefined);
            r.mod = safe(() => si.Module === undefined ? undefined : String(si.Module), undefined);
        }
    }
    return r;
}

// ------------------------------------------------------------------ display

function fmtNumber(n, hint, hex) {
    let t = hint;
    if (t && typeKind(t) === "enum") {
        let fields = safe(() => t.fields, undefined);
        if (fields) {
            for (let name of propNames(fields)) {
                let val = safe(() => num(fields[name].value), undefined);
                if (val === n) return name + " (" + (hex ? "0x" + n.toString(16) : n) + ")";
            }
        }
    }
    if (t && isCharType(t)) {
        let ch = n < 0 ? n + 256 : n;
        let shown = ch === 0 ? "\\0" : (ch < 32 ? "\\x" + ch.toString(16) : String.fromCharCode(ch));
        return (hex ? "0x" + ch.toString(16) : String(n)) + " '" + shown + "'";
    }
    if (hex && Number.isInteger(n)) {
        if (n < 0) {
            let size = safe(() => num(t.size), 4);
            n = size >= 8 ? n : (n >>> 0);
            if (n < 0) return "-0x" + (-n).toString(16);
        }
        return "0x" + n.toString(16);
    }
    return String(n);
}

function fmtInt64(v, hex) {
    if (hex) return "0x" + v.toString(16);
    return v.toString(10);
}

function readCString(addr, elemSize, maxLen) {
    let s;
    if (elemSize === 2) s = host.memory.readWideString(addr);
    else s = host.memory.readString(addr);
    if (maxLen !== undefined && s.length > maxLen) s = s.substr(0, maxLen);
    return s;
}

function readFixedString(addr, elemSize, count) {
    let s = elemSize === 2 ? host.memory.readWideString(addr, count) : host.memory.readString(addr, count);
    let z = s.indexOf("\0");
    return z >= 0 ? s.substr(0, z) : s;
}

function fmtPointer(v, t, hex, depth) {
    let addr = safe(() => v.address, undefined);
    let digits = safe(() => num(t.size), 8) * 2;
    let s = "0x" + pad(addr === undefined ? "0" : addr.toString(16), digits);
    if (safe(() => v.isNull, false)) return s + " <NULL>";
    let base = safe(() => t.baseType, undefined);
    if (!base) return s;
    let bk = typeKind(base);
    if (isCharType(base)) {
        try {
            let str = readCString(addr, charSize(base), MAX_DISPLAY_STRING);
            return s + " " + (charSize(base) === 2 ? "L" : "") + quote(str);
        } catch (e) {
            return s + " <Error reading characters of string>";
        }
    }
    if (bk === "function" || typeName(base) === "void") return s;
    if (depth >= 1) return s;
    try {
        let target = runtimeTyped(v.dereference());
        if (bk === "udt") return s + " " + display(target, base, hex, depth + 1);
        return s + " {" + display(target, base, hex, depth + 1) + "}";
    } catch (e) {
        return s + " {???}";
    }
}

function arrayLength(t) {
    let size = safe(() => num(t.size), 0);
    let esize = safe(() => num(t.baseType.size), 0);
    return esize > 0 ? Math.floor(size / esize) : 0;
}

function fmtArray(v, t, hex, depth) {
    let base = safe(() => t.baseType, undefined);
    let n = arrayLength(t);
    if (base && isCharType(base)) {
        try {
            let loc = v.targetLocation;
            return (charSize(base) === 2 ? "L" : "") + quote(readFixedString(loc, charSize(base), n));
        } catch (e) { /* fall through to element list */ }
    }
    if (depth >= 2) return "{...}";
    let parts = [];
    let limit = Math.min(n, 8);
    for (let i = 0; i < limit; i++) {
        parts.push(safe(() => display(normalize(v[i]), base, hex, depth + 1), "?"));
    }
    return "{" + parts.join(", ") + (n > limit ? ", ..." : "") + "}";
}

function memberFields(t) {
    let out = [];
    let fields = safe(() => t.fields, undefined);
    if (!fields) return out;
    for (let name of propNames(fields)) {
        let f = safe(() => fields[name], undefined);
        if (!f) continue;
        if (safe(() => String(f.locationKind), "member") !== "member") continue;
        out.push({ name: name, type: safe(() => f.type, undefined), offset: safe(() => num(f.offset), undefined), bit: safe(() => f.type.isBitField, false) });
    }
    return out;
}

function baseClasses(t) {
    return safe(() => Array.from(t.baseClasses), []);
}

function rawMemberNames(t) {
    let key = typeName(t);
    if (key && rawMemberCache.has(key)) return rawMemberCache.get(key);
    let names = new Set();
    let visit = (ty, depth) => {
        if (!ty || depth > 16) return;
        let fields = safe(() => ty.fields, undefined);
        if (fields) for (let n of propNames(fields)) names.add(n);
        for (let b of baseClasses(ty)) visit(safe(() => b.type, undefined), depth + 1);
    };
    visit(t, 0);
    if (key) rawMemberCache.set(key, names);
    return names;
}

function fmtUdt(v, t, hex, depth) {
    let s = safe(() => String(v), "[object Object]");
    if (s !== "[object Object]" && s !== "") return s;
    if (depth >= 2) return "{...}";
    let parts = [];
    let total = 0;
    for (let b of baseClasses(t)) {
        parts.push("{...}");
        total++;
        if (parts.length >= MAX_SUMMARY_FIELDS) break;
    }
    for (let f of memberFields(t)) {
        total++;
        if (parts.length >= MAX_SUMMARY_FIELDS) continue;
        parts.push(f.name + "=" + safe(() => display(normalize(v[f.name]), f.type, hex, depth + 1), "?"));
    }
    return "{" + parts.join(" ") + (total > parts.length ? " ..." : "") + "}";
}

function display(v, hint, hex, depth) {
    depth = depth || 0;
    if (v === undefined) return "<unavailable>";
    if (v === null) return "null";
    let jt = typeof v;
    if (jt === "boolean") return v ? "true" : "false";
    if (jt === "string") return quote(v);
    if (jt === "number") return fmtNumber(v, hint, hex);
    if (jt === "function") return "<function>";
    if (isInt64(v)) return fmtInt64(v, hex);
    if (jt !== "object") return String(v);
    let t = typeOf(v);
    if (!t) {
        let s = safe(() => String(v), "");
        return s === "[object Object]" ? "{...}" : s;
    }
    switch (typeKind(t)) {
        case "pointer": return fmtPointer(v, t, hex, depth);
        case "array": return fmtArray(v, t, hex, depth);
        case "udt": return fmtUdt(v, t, hex, depth);
        default: {
            let s = safe(() => String(v), "");
            return s === "[object Object]" ? "{...}" : s;
        }
    }
}

// ---------------------------------------------------------------- variables

function newHandle(entry) {
    let id = nextHandle++;
    entry.children = new Map();
    // Children of a hover value are listed under the same rule as the hover.
    entry.noLoad = noLoad;
    entry.module = currentFrameModule;
    handles.set(id, entry);
    return id;
}

function getHandle(ref) {
    let e = handles.get(ref);
    if (!e) throw new Error("This value is no longer available");
    return e;
}

function joinEval(parent, child, viaPointer) {
    if (!parent) return undefined;
    let p = /^[A-Za-z_][\w.:>\-\[\]]*$/.test(parent) || /^\(.*\)$/.test(parent) ? parent : "(" + parent + ")";
    return p + (viaPointer ? "->" : ".") + child;
}

function addrEval(v, t) {
    let a = addressOf(v);
    let n = typeName(t || typeOf(v));
    if (a === undefined || !n) return undefined;
    return "*(" + n + " *)0x" + a;
}

// Describes the shape of an expandable value without enumerating it.
function expandInfo(v) {
    let t = typeOf(v);
    if (!t) {
        if (v !== null && typeof v === "object" && !isInt64(v)) return { expandable: propNames(v).some(n => !META.has(n)) };
        return { expandable: false };
    }
    let k = typeKind(t);
    if (k === "pointer") {
        if (safe(() => v.isNull, true)) return { expandable: false };
        let base = safe(() => t.baseType, undefined);
        let bn = typeName(base);
        if (!base || bn === "void" || typeKind(base) === "function") return { expandable: false };
        return { expandable: true };
    }
    if (k === "array") {
        let n = arrayLength(t);
        return { expandable: n > 0, indexed: n > 100 ? n : undefined };
    }
    if (k === "udt") return { expandable: true };
    return { expandable: false };
}

function makeVar(parent, name, v, hint, evalName, opts) {
    opts = opts || {};
    v = normalize(v);
    let r = { name: name };
    r.value = safe(() => display(v, hint, opts.hex, 0), "<error>");
    let t = typeOf(v);
    r.type = typeName(t) || typeName(hint);
    if (evalName) r.evalName = evalName;
    let info = expandInfo(v);
    if (info.expandable) {
        r.ref = newHandle({ kind: "value", obj: v, hint: hint, evalName: evalName });
        if (info.indexed !== undefined) r.indexed = info.indexed;
    }
    let addr = opts.addr !== undefined ? opts.addr : addressOf(v);
    if (addr !== undefined) r.mem = addr;
    if (parent) {
        parent.children.set(name, { obj: v, hint: hint, evalName: evalName, addr: addr, typeName: r.type });
    }
    return r;
}

function localsOf(e, opts) {
    ensureContext(e.tid, e.fi);
    let frame = frameAt(findThread(e.tid), e.fi);
    let out = [];
    let seen = new Set();
    let sources = [safe(() => frame.Parameters, undefined), safe(() => frame.LocalVariables, undefined)];
    for (let src of sources) {
        if (!src) continue;
        for (let name of propNames(src)) {
            if (META.has(name) || name.charAt(0) === "<" || seen.has(name)) continue;
            let v;
            try { v = src[name]; } catch (err) { out.push({ name: name, value: "<" + errMsg(err) + ">" }); continue; }
            if (typeof v === "function") continue;
            seen.add(name);
            let hint, addr;
            if (v === null || typeof v !== "object" || isInt64(v)) {
                try {
                    let p = host.evaluateExpression("&" + name);
                    hint = p.targetType.baseType;
                    addr = hexOf(p.address);
                } catch (err) { /* register variable: no address */ }
            }
            out.push(makeVar(e, name, v, hint, name, { hex: opts.hex, addr: addr }));
        }
    }
    return out;
}

function registersOf(e, opts) {
    let regs = safe(() => findThread(e.tid).Registers.User, undefined);
    if (!regs) return [];
    let out = [];
    for (let name of propNames(regs)) {
        if (META.has(name)) continue;
        let v = safe(() => regs[name], undefined);
        if (v === undefined || typeof v === "function") continue;
        let shown = isInt64(v) ? "0x" + pad(v.toString(16), name.length === 3 && name.charAt(0) === "r" ? 16 : 1) : (typeof v === "number" ? "0x" + v.toString(16) : display(v, undefined, true, 0));
        out.push({ name: name, value: shown, evalName: "@" + name });
    }
    return out;
}

function rawChildren(e, v, opts) {
    let out = [];
    let t = typeOf(v);
    if (!t) return out;
    let loc = safe(() => v.targetLocation, undefined);
    for (let b of baseClasses(t)) {
        let bt = safe(() => b.type, undefined);
        let bn = typeName(bt) || String(b.name);
        try {
            let bo = host.createTypedObject(loc.add(num(b.offset)), bt);
            let ev;
            if (e.evalName) ev = e.viaPtr ? "(*(" + bn + " *)" + wrap(e.evalName) + ")" : "(*(" + bn + " *)&" + wrap(e.evalName) + ")";
            out.push(makeVar(e, "[" + bn + "]", bo, bt, ev, opts));
        } catch (err) {
            out.push({ name: "[" + bn + "]", value: "<" + errMsg(err) + ">" });
        }
    }
    for (let f of memberFields(t)) {
        let child;
        try { child = v[f.name]; } catch (err) { out.push({ name: f.name, value: "<" + errMsg(err) + ">", type: typeName(f.type) }); continue; }
        let addr;
        if (loc !== undefined && f.offset !== undefined && !f.bit && (child === null || typeof child !== "object" || isInt64(child))) {
            addr = safe(() => hexOf(loc.add(f.offset)), undefined);
        }
        out.push(makeVar(e, f.name, child, f.type, joinEval(e.evalName, f.name, !!e.viaPtr), { hex: opts.hex, addr: addr }));
    }
    return out;
}

function wrap(expr) {
    return /^[A-Za-z_][\w]*$/.test(expr) ? expr : "(" + expr + ")";
}

function itemHint(v) {
    let t = typeOf(v);
    let args = safe(() => Array.from(t.genericArguments), []);
    if (args.length > 0 && typeof args[0] === "object" && safe(() => args[0].typeKind, undefined) !== undefined) return args[0];
    return undefined;
}

function collectItems(e, v) {
    if (e.items) return e.items;
    let items = [];
    let truncated = false;
    try {
        for (let item of v) {
            if (items.length >= MAX_ITEMS) { truncated = true; break; }
            items.push(item);
        }
    } catch (err) {
        items.error = errMsg(err);
    }
    items.truncated = truncated;
    e.items = items;
    return items;
}

function itemVar(e, v, items, i, opts, hint) {
    let item = normalize(items[i]);
    let ev = addrEval(item);
    return makeVar(e, "[" + i + "]", item, hint, ev, opts);
}

// Children of a value: synthetic visualizer items, iterated items, raw view.
function valueChildren(e, req, opts) {
    let v = e.obj;
    let t = typeOf(v);
    let filter = req.filter;
    let start = req.start || 0;
    let count = req.count || 0;
    if (!t) {
        let out = [];
        for (let name of propNames(v)) {
            if (META.has(name)) continue;
            let c = safe(() => v[name], undefined);
            if (typeof c === "function") continue;
            out.push(makeVar(e, name, c, undefined, undefined, opts));
        }
        return { vars: out };
    }
    let k = typeKind(t);
    if (k === "pointer") {
        let target = runtimeTyped(v.dereference());
        let base = safe(() => t.baseType, undefined);
        if (typeKind(base) === "udt") {
            let inner = { kind: "value", obj: target, hint: base, evalName: e.evalName, viaPtr: true, children: e.children };
            return valueChildren(inner, req, opts);
        }
        return { vars: [makeVar(e, "*" + (e.name || ""), target, base, e.evalName ? "*" + wrap(e.evalName) : undefined, opts)] };
    }
    if (k === "array") {
        let n = arrayLength(t);
        let base = safe(() => t.baseType, undefined);
        let from = filter === "indexed" ? start : 0;
        let to = filter === "indexed" && count > 0 ? Math.min(n, start + count) : Math.min(n, MAX_ITEMS);
        let out = [];
        for (let i = from; i < to; i++) {
            let item;
            try { item = v[i]; } catch (err) { out.push({ name: "[" + i + "]", value: "<" + errMsg(err) + ">" }); continue; }
            let addr;
            if (item === null || typeof item !== "object" || isInt64(item)) {
                addr = safe(() => hexOf(v.targetLocation.add(i * num(base.size))), undefined);
            }
            out.push(makeVar(e, "[" + i + "]", item, base, e.evalName ? wrap(e.evalName) + "[" + i + "]" : undefined, { hex: opts.hex, addr: addr }));
        }
        return { vars: out };
    }
    if (k !== "udt") return { vars: [] };
    if (e.raw) return { vars: rawChildren(e, v, opts) };

    let props = propNames(v);
    let raw = rawMemberNames(t);
    let synthetic = [];
    let visualized = props.indexOf("ToDisplayString") >= 0;
    for (let name of props) {
        if (META.has(name) || raw.has(name)) continue;
        let bracket = name.charAt(0) === "[";
        if (!bracket && /^_[A-Z_]/.test(name)) continue;
        let c;
        try { c = v[name]; } catch (err) { continue; }
        if (typeof c === "function") continue;
        synthetic.push({ name: name, value: c });
        visualized = true;
    }
    let iterable = isIterable(v);
    if (iterable) visualized = true;
    if (!visualized) return { vars: rawChildren(e, v, opts) };

    let named = [];
    if (filter !== "indexed") {
        for (let sv of synthetic) named.push(makeVar(e, sv.name, sv.value, undefined, addrEval(normalize(sv.value)), opts));
    }
    let items = iterable ? collectItems(e, v) : [];
    let hint = itemHint(v);
    let indexedCount = items.length;
    let vars = named;
    if (filter === "indexed") {
        let to = count > 0 ? Math.min(items.length, start + count) : items.length;
        for (let i = start; i < to; i++) vars.push(itemVar(e, v, items, i, opts, hint));
        return { vars: vars };
    }
    if (filter !== "named" && indexedCount <= 100) {
        for (let i = 0; i < items.length; i++) vars.push(itemVar(e, v, items, i, opts, hint));
    }
    if (items.truncated) vars.push({ name: "[...]", value: "Only the first " + MAX_ITEMS + " items are shown" });
    if (items.error) vars.push({ name: "[error]", value: items.error });
    if (raw.size > 0 && filter !== "indexed") {
        let rawEval = e.evalName ? (e.viaPtr ? "*" + wrap(e.evalName) : e.evalName) + ",!" : undefined;
        let rawRef = newHandle({ kind: "value", obj: v, hint: e.hint, evalName: e.evalName, viaPtr: e.viaPtr, raw: true });
        vars.push({ name: "[Raw View]", value: "", ref: rawRef, evalName: rawEval });
    }
    return { vars: vars, indexed: indexedCount > 100 ? indexedCount : undefined };
}

// Looks up a child listed by a previous `children` call, listing it now if needed.
function childOf(e, name) {
    let c = e.children.get(name);
    if (!c) {
        if (e.kind === "locals") localsOf(e, {});
        else if (e.kind === "value") valueChildren(e, {}, {});
        c = e.children.get(name);
    }
    if (!c) throw new Error("Unknown variable " + name);
    return c;
}

// ------------------------------------------------------------------ modules

function moduleBaseName(name) {
    return String(name).replace(/^.*[\\/]/, "").replace(/\.(dll|exe|sys|drv|ocx|cpl|pyd)$/i, "");
}

// Reading SymbolType does not load anything: a deferred module stays deferred.
function readModules() {
    let out = [];
    for (let m of host.currentProcess.Modules) {
        let base = safe(() => num(m.BaseAddress), undefined);
        if (base === undefined) continue;
        out.push({
            name: moduleBaseName(safe(() => String(m.Name), "")),
            base: base,
            end: base + safe(() => num(m.Size), 0),
            deferred: safe(() => String(m.SymbolType), "") === "Deferred"
        });
    }
    return out;
}

function moduleTable() {
    if (noLoadModules) return noLoadModules;
    return readModules();
}

function moduleAt(table, addr) {
    for (let m of table) if (addr >= m.base && addr < m.end) return m;
    return undefined;
}

function moduleNamed(table, name) {
    let n = moduleBaseName(name).toLowerCase();
    for (let m of table) if (m.name.toLowerCase() === n) return m;
    return undefined;
}

function addSymbolHint(hint) {
    if (!symbolHints.some(h => h.module === hint.module)) symbolHints.push(hint);
}

// Runs f with symbol loading forbidden; reports what would have needed symbols, and the modules
// whose symbols got loaded anyway (natvis expressions naming another module do that).
function withoutLoads(f) {
    let prevNoLoad = noLoad, prevModules = noLoadModules, prevHints = symbolHints;
    noLoad = true;
    noLoadModules = readModules();
    symbolHints = [];
    let before = noLoadModules.filter(m => m.deferred).map(m => m.name);
    let finish = (r) => {
        if (symbolHints.length > 0) r.needSymbols = symbolHints;
        let after = new Set(readModules().filter(m => m.deferred).map(m => m.name));
        let loaded = before.filter(n => !after.has(n));
        if (loaded.length > 0) r.loadedSymbols = loaded;
        return r;
    };
    try {
        return finish(f());
    } catch (e) {
        // The failure still says which symbols would have helped.
        if (symbolHints.length === 0) throw e;
        return finish({ failed: errMsg(e) });
    } finally {
        noLoad = prevNoLoad;
        noLoadModules = prevModules;
        symbolHints = prevHints;
    }
}

// MSVC stores a pointer to the RTTI Complete Object Locator just before the vtable. A valid
// locator tells a polymorphic object from one whose first field merely points into a module, and
// gives the dynamic type's name and module without any symbols.
function dynamicType(v) {
    let size = ptrSize();
    let table = moduleTable();
    let obj = int64(hexOf(v.targetLocation));
    let vptr = readPtr(obj, size);
    let m = moduleAt(table, num(vptr));
    if (!m) return undefined;
    let col = readPtr(vptr.subtract(size), size);
    if (moduleAt(table, num(col)) !== m) return undefined;
    let td;
    if (size === 8) {
        // x64 locators hold image-relative offsets, the last one pointing back at the locator.
        if (read32(col) !== 1 || m.base + read32(col.add(20)) !== num(col)) return undefined;
        td = m.base + read32(col.add(12));
    } else {
        if (read32(col) !== 0) return undefined;
        td = read32(col.add(12));
    }
    let decorated = host.memory.readString(int64((td + 2 * size).toString(16)));
    if (decorated.indexOf(".?A") !== 0) return undefined;
    return { module: m, typeName: undecorateTypeName(decorated), complete: obj.subtract(read32(col.add(4))) };
}

// The dynamic type is described by a module whose symbols are deferred. The frame's module often
// knows the same type from a shared header; otherwise the static type is shown and the module is
// reported.
function dynamicWithoutLoad(v, dyn) {
    let home = currentModule();
    if (home && !home.deferred && dyn.typeName.indexOf("?") < 0) {
        let t = safe(() => host.getModuleType(home.name, dyn.typeName), undefined);
        let r = t ? safe(() => host.createTypedObject(dyn.complete, t), undefined) : undefined;
        if (r) return r;
    }
    addSymbolHint({ module: dyn.module.name, type: dyn.typeName.indexOf("?") < 0 ? dyn.typeName : undefined });
    return v;
}

// Module of the frame an expression is evaluated in (set by evaluateValue).
let currentFrameModule;

function currentModule() {
    return currentFrameModule ? moduleNamed(moduleTable(), currentFrameModule) : undefined;
}

// ------------------------------------------------------------- name lookup
//
// dbgeng binds a bare name to a local or parameter and otherwise searches the symbols of every
// module: it never looks at the members of `this`. With hundreds of modules that search takes
// minutes, and with unqualified loads enabled it loads every deferred PDB. Names are resolved
// here the way Visual Studio does instead, without leaving the frame's module: locals and
// parameters, members of `this` (inherited ones included), the classes and namespaces enclosing
// the function, then the module's globals. "module!name" and Visual Studio's context operator
// "{,,module.dll}name" name another module explicitly.

const CPP_KEYWORDS = new Set([
    "this", "true", "false", "nullptr", "sizeof", "alignof", "const", "volatile", "unsigned", "signed",
    "char", "wchar_t", "char8_t", "char16_t", "char32_t", "short", "int", "long", "float", "double",
    "bool", "void", "auto", "__int8", "__int16", "__int32", "__int64", "struct", "class", "union", "enum",
    "typename", "static_cast", "dynamic_cast", "reinterpret_cast", "const_cast", "new", "delete", "operator"
]);
const CAST_KEYWORDS = new Set(["static_cast", "dynamic_cast", "reinterpret_cast", "const_cast"]);
const STRING_PREFIXES = new Set(["L", "u", "U", "u8", "R", "LR", "uR", "UR", "u8R"]);
const TWO_CHAR_OPS = ["::", "->", "++", "--", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>"];
// Data model syntax (LINQ lambdas, @$ variables, the Debugger namespace) is passed through.
const DATA_MODEL_SYNTAX = /@\$|=>|^\s*Debugger\./;
const VS_CONTEXT = /\{\s*[^{},]*,\s*[^{},]*,\s*([^{},]+?)\s*\}\s*/g;

// Splits an expression into identifier ("id"), number, string, register ("reg") and operator
// tokens with their positions.
function scanTokens(expr) {
    let out = [];
    let i = 0;
    let n = expr.length;
    let isId = c => /[A-Za-z0-9_]/.test(c);
    while (i < n) {
        let c = expr[i];
        let start = i;
        if (/\s/.test(c)) { i++; continue; }
        if (c === "\"" || c === "'") {
            i++;
            while (i < n && expr[i] !== c) i += expr[i] === "\\" ? 2 : 1;
            i = Math.min(i + 1, n);
            out.push({ k: "str", s: expr.slice(start, i), start: start, end: i });
            continue;
        }
        if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(expr[i + 1] || ""))) {
            while (i < n && /[A-Za-z0-9_.`]/.test(expr[i])) i++;
            out.push({ k: "num", s: expr.slice(start, i), start: start, end: i });
            continue;
        }
        if (c === "@" || c === "$") {
            i++;
            while (i < n && (isId(expr[i]) || expr[i] === "$" || expr[i] === "@")) i++;
            out.push({ k: "reg", s: expr.slice(start, i), start: start, end: i });
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            while (i < n && isId(expr[i])) i++;
            let s = expr.slice(start, i);
            if (STRING_PREFIXES.has(s) && (expr[i] === "\"" || expr[i] === "'")) {
                let q = expr[i++];
                while (i < n && expr[i] !== q) i += expr[i] === "\\" ? 2 : 1;
                i = Math.min(i + 1, n);
                out.push({ k: "str", s: expr.slice(start, i), start: start, end: i });
                continue;
            }
            out.push({ k: "id", s: s, start: start, end: i });
            continue;
        }
        let two = expr.substr(i, 2);
        if (TWO_CHAR_OPS.indexOf(two) >= 0) {
            out.push({ k: "op", s: two, start: start, end: i + 2 });
            i += 2;
            continue;
        }
        out.push({ k: "op", s: c, start: start, end: i + 1 });
        i++;
    }
    return out;
}

// Visual Studio does not evaluate hovers that would change the target.
function checkSideEffects(toks) {
    for (let i = 0; i < toks.length; i++) {
        let t = toks[i];
        let next = toks[i + 1];
        let call = t.k === "id" && !CPP_KEYWORDS.has(t.s) && next && next.s === "(";
        if (t.s === "=" || t.s === "++" || t.s === "--" || call) {
            throw new Error("This expression has side effects and will not be evaluated.");
        }
    }
}

// "(Type)x", "(Type *)p", "sizeof(Type)": a name alone in parentheses followed by an operand, or
// followed by * & const before the closing parenthesis.
function isTypePosition(toks, i, end) {
    let prev = toks[i - 1];
    if (!prev || prev.s !== "(") return false;
    let k = end + 1;
    let declarator = false;
    while (toks[k] && (toks[k].s === "*" || toks[k].s === "&" || toks[k].s === "&&" || toks[k].s === "const" || toks[k].s === "volatile")) {
        k++;
        declarator = true;
    }
    if (!toks[k] || toks[k].s !== ")") return false;
    if (declarator) return true;
    let before = toks[i - 2];
    if (before && (before.s === "sizeof" || before.s === "alignof")) return true;
    let after = toks[k + 1];
    return !!after && (after.k === "id" || after.k === "num" || after.k === "str" || after.k === "reg" || after.s === "(");
}

// Rewrites the free names of an expression with lookup(parts, next, module), which returns
// { text, value } to replace the name, or undefined to keep it. Returns the new expression and,
// when the expression is a single name that was looked up, its value.
function rewriteNames(expr, lookup) {
    if (DATA_MODEL_SYNTAX.test(expr)) return { expr: expr };
    expr = expr.replace(VS_CONTEXT, (m, mod) => moduleBaseName(mod.trim().replace(/^"|"$/g, "")) + "!");
    let toks = scanTokens(expr);
    let out = "";
    let pos = 0;
    let value;
    let castDepth = 0;
    for (let i = 0; i < toks.length; i++) {
        let t = toks[i];
        if (t.k === "reg" && castDepth === 0) {
            let r = lookup([t.s], toks[i + 1], undefined);
            if (r) {
                out += expr.slice(pos, t.start) + r.text;
                pos = t.end;
                if (toks.length === 1) value = r.value;
            }
            continue;
        }
        if (t.k !== "id") {
            if (castDepth > 0) {
                if (t.s === "<") castDepth++;
                else if (t.s === ">") castDepth--;
                else if (t.s === ">>") castDepth = Math.max(0, castDepth - 2);
            }
            continue;
        }
        if (CAST_KEYWORDS.has(t.s) && toks[i + 1] && toks[i + 1].s === "<") {
            castDepth = Math.max(castDepth, 1);
            i++;
            continue;
        }
        // module!name::name, or name::name
        let first = i;
        let module;
        let bang = toks[i + 1];
        if (bang && bang.s === "!" && bang.start === t.end && toks[i + 2] && toks[i + 2].k === "id" && toks[i + 2].start === bang.end) {
            module = t.s;
            i += 2;
        }
        let parts = [toks[i].s];
        while (toks[i + 1] && toks[i + 1].s === "::" && toks[i + 2] && toks[i + 2].k === "id") {
            parts.push(toks[i + 2].s);
            i += 2;
        }
        let prev = toks[first - 1];
        let memberAccess = prev && (prev.s === "." || prev.s === "->" || prev.s === "::");
        if (memberAccess || castDepth > 0) continue;
        if (!module && (CPP_KEYWORDS.has(parts[0]) || isTypePosition(toks, first, i))) continue;
        let r = lookup(parts, toks[i + 1], module);
        if (!r) continue;
        out += expr.slice(pos, toks[first].start) + r.text;
        pos = toks[i].end;
        if (first === 0 && i === toks.length - 1) value = r.value;
    }
    out += expr.slice(pos);
    return { expr: out, value: value };
}

// "ns::Class<T>::method" -> ["ns::Class<T>", "ns"]. Lambdas and anonymous namespaces end it.
function enclosingScopes(fn) {
    if (!fn) return [];
    let parts = [];
    let depth = 0;
    let cur = "";
    for (let i = 0; i < fn.length; i++) {
        let c = fn[i];
        if (c === "<" || c === "(") depth++;
        else if ((c === ">" || c === ")") && depth > 0) depth--;
        if (depth === 0 && c === ":" && fn[i + 1] === ":") {
            parts.push(cur);
            cur = "";
            i++;
            continue;
        }
        cur += c;
    }
    let stop = parts.findIndex(p => p === "" || p.charAt(0) === "`" || p.indexOf("<lambda") === 0);
    if (stop >= 0) parts = parts.slice(0, stop);
    let out = [];
    for (let k = parts.length; k > 0; k--) out.push(parts.slice(0, k).join("::"));
    return out;
}

// What a frame can see: locals and parameters, members of `this`, its module and enclosing
// scopes. The frame must be the current context (ensureContext), for `this`.
function frameScope(tid, fi) {
    let key = (tid === undefined || tid === null ? "-" : tid) + ":" + (fi || 0);
    let s = frameScopes.get(key);
    if (s) return s;
    let frame = frameAt(findThread(tid), fi || 0);
    let names = new Set();
    for (let src of [safe(() => frame.Parameters, undefined), safe(() => frame.LocalVariables, undefined)]) {
        if (src) for (let n of propNames(src)) if (!META.has(n)) names.add(n);
    }
    let members = new Set();
    if (names.has("this")) {
        let t = safe(() => host.evaluateExpression("this").targetType.baseType, undefined);
        if (t) members = rawMemberNames(t);
    }
    let si = safe(() => frame.Attributes.SourceInformation, undefined);
    let fn = si ? safe(() => String(si.FunctionName), undefined) : undefined;
    let module = si ? safe(() => String(si.Module.Name), undefined) : undefined;
    s = { names: names, members: members, module: module, scopes: enclosingScopes(fn) };
    frameScopes.set(key, s);
    return s;
}

// Expression text for a global found by getModuleSymbol; undefined for functions.
function objectText(v) {
    let t = typeOf(v);
    let loc = safe(() => hexOf(v.targetLocation), undefined);
    let n = typeName(t);
    if (!t || !loc || !n || n.indexOf("(") >= 0) return undefined;
    let k = typeKind(t);
    if (k === "function") return undefined;
    if (k === "array") return "(*(" + typeName(t.baseType) + "(*)[" + arrayLength(t) + "])0x" + loc + ")";
    return "(*(" + n + " *)0x" + loc + ")";
}

// Looks a name up in one module; returns { value, text } (text: an expression for it that needs no
// symbol search), or null. A module whose symbols are deferred is not loaded for a hover.
function moduleSymbol(module, name) {
    let m = moduleNamed(moduleTable(), module);
    if (!m) throw new Error("Module " + module + " is not loaded");
    if (m.deferred && noLoad) {
        addSymbolHint({ module: m.name });
        throw new Error("Symbols for " + m.name + " are not loaded");
    }
    if (m.deferred) {
        // getModuleSymbol does not always load deferred symbols first: it can just answer null.
        for (let line of host.namespace.Debugger.Utility.Control.ExecuteCommand("ld " + m.name)) { /* output not needed */ }
        m.deferred = false;
    }
    return moduleGlobal(m.name, name);
}

// getModuleSymbol hands intrinsic values (int, double, bool, enums...) over as plain JS values,
// without type or address; `x /t` in that one module gives the type.
function moduleGlobal(module, name) {
    let v = safe(() => host.getModuleSymbol(module, name), null);
    if (v === null || v === undefined) {
        // A public symbol without type information (Microsoft's public PDBs, such as ucrtbased's
        // _crtBreakAlloc): Visual Studio reads it as an int.
        let at = safe(() => untypedDataAddress(module, name), undefined);
        if (at === undefined) return null;
        let untyped = "(*(int *)0x" + hexOf(at) + ")";
        return { value: host.evaluateExpression(untyped), text: untyped };
    }
    if (typeof v === "object" && !isInt64(v)) return { value: v, text: objectText(v) };
    let addr = safe(() => host.getModuleSymbolAddress(module, name), undefined);
    let type = addr !== undefined ? safe(() => symbolTypeName(module, name), undefined) : undefined;
    let text = type && type.indexOf("(") < 0 ? "(*(" + type + " *)0x" + hexOf(addr) + ")" : undefined;
    return { value: v, text: text };
}

// getModuleSymbolAddress does not find public symbols without type information; `x` does:
// "00007ffd`9584b000 plugin!app::pluginCounter = <no type information>". Functions are left out.
function untypedDataAddress(module, name) {
    for (let line of host.namespace.Debugger.Utility.Control.ExecuteCommand("x /d " + module + "!" + name)) {
        let m = /^\s*([0-9a-f`]+)\s+(\S+)\s*=\s*<no type information>/i.exec(String(line));
        if (m && m[2].toLowerCase() === (module + "!" + name).toLowerCase()) return int64(m[1]);
    }
    return undefined;
}

function symbolTypeName(module, name) {
    for (let line of host.namespace.Debugger.Utility.Control.ExecuteCommand("x /t /d " + module + "!" + name)) {
        // 00007ff6`ed566000 int sample!app::globalLimit = 0n100
        let m = /^\s*[0-9a-f`]+\s+(.+?)\s+\S+!\S+\s*=/i.exec(String(line));
        if (m) return m[1].replace(/^(struct|class|union|enum)\s+/, "");
    }
    return undefined;
}

function moduleSymbolType(module) {
    let wanted = moduleBaseName(module).toLowerCase();
    for (let m of host.currentProcess.Modules) {
        if (moduleBaseName(safe(() => String(m.Name), "")).toLowerCase() === wanted) return safe(() => String(m.SymbolType), undefined);
    }
    return undefined;
}

// A register of the current thread ("rdi", "edi", "dil"...) as an unsigned __int64 literal.
function registerRef(name) {
    let regs = safe(() => host.currentThread.Registers.User, undefined);
    if (!regs) return undefined;
    let lower = name.toLowerCase();
    let key = propNames(regs).find(n => !META.has(n) && n.toLowerCase() === lower);
    if (!key) return undefined;
    let v = safe(() => regs[key], undefined);
    if (typeof v !== "number" && !isInt64(v)) return undefined;
    return { text: "((unsigned __int64)0x" + v.toString(16) + ")", value: v };
}

// Visual Studio's pseudo-variables, as numbers.
const PSEUDO_VARIABLES = {
    tid: () => num(host.currentThread.Id),
    pid: () => num(host.currentProcess.Id),
    err: () => {
        let v = safe(() => num(host.currentThread.Environment.EnvironmentBlock.LastErrorValue), undefined);
        if (typeof v === "number" && !isNaN(v)) return v;
        // Without ntdll's PDB the TEB has no type: read LastErrorValue at its fixed offset.
        return read32(tebAddress().add(ptrSize() === 8 ? 0x68 : 0x34));
    }
};

function tebAddress() {
    for (let line of host.namespace.Debugger.Utility.Control.ExecuteCommand("? @$teb")) {
        // Evaluate expression: 129257791488 = 0000001e`185d6000
        let m = /=\s*([0-9a-f`]+)\s*$/i.exec(String(line));
        if (m) return int64(m[1]);
    }
    throw new Error("The thread environment block is not available");
}

// "$rdi", "@rdi" (registers) and "$tid", "$pid", "$err". Anything else would go to dbgeng's
// search of every module, so it is an error.
function pseudoRef(token) {
    let name = token.slice(1);
    let reg = registerRef(name);
    if (reg) return reg;
    let pv = token.charAt(0) === "$" ? PSEUDO_VARIABLES[name.toLowerCase()] : undefined;
    if (pv) {
        let v = pv();
        return { text: "(" + String(v) + ")", value: v };
    }
    throw new Error("\"" + token + "\" is not a register or a pseudo-variable");
}

// The lookup used by rewriteNames. strict: a name found nowhere is an error instead of being left
// to dbgeng's search of every module. registers: a bare register name ("rdi") is the register
// when no variable has that name; not for hovers, where the word under the mouse rarely is one.
function nameLookup(scope, strict, registers) {
    let global = (parts) => {
        if (!scope.module) return undefined;
        let name = parts.join("::");
        for (let s of scope.scopes.concat([""])) {
            let full = s ? s + "::" + name : name;
            let r = moduleSymbol(scope.module, full);
            if (r !== null) return { text: r.text || full, value: r.value };
        }
        return undefined;
    };
    return (parts, next, module) => {
        if (module) {
            let r = moduleSymbol(module, parts.join("::"));
            if (r === null) {
                let exportsOnly = moduleSymbolType(module) === "Export" ? " (" + module + " has export symbols only: no PDB was found for it)" : "";
                throw new Error("identifier \"" + module + "!" + parts.join("::") + "\" is undefined" + exportsOnly);
            }
            return { text: r.text || module + "!" + parts.join("::"), value: r.value };
        }
        let id = parts[0];
        if (parts.length === 1 && (id.charAt(0) === "$" || id.charAt(0) === "@")) return pseudoRef(id);
        if (parts.length === 1) {
            if (scope.names.has(id)) return undefined;
            if (scope.members.has(id)) return { text: "this->" + id };
        } else if (scope.names.has(id)) {
            return undefined;
        }
        let found = global(parts);
        if (found) return found;
        // Functions, and qualified names (types, enumerators) are left to dbgeng.
        if ((next && next.s === "(") || parts.length > 1) return undefined;
        let reg = registers ? registerRef(id) : undefined;
        if (reg) return reg;
        if (strict) throw new Error("identifier \"" + id + "\" is undefined");
        return undefined;
    };
}

// --------------------------------------------------------------- evaluation

const FORMAT = /^(.*\S)\s*,\s*(x|X|h|d|sz|s8b|sub|s8|sb|su|s|!|\[?\d+\]?)$/;
// String format specifiers and their character size: ",s", ",sz" and ",s8" narrow, ",su" UTF-16;
// a trailing "b" drops the quotes.
const STRING_SPECS = { s: 1, sz: 1, s8: 1, sb: 1, s8b: 1, su: 2, sub: 2 };

// What a pointer, a char array or an address points to, read as a string whatever its type.
function specString(v, spec) {
    let es = STRING_SPECS[spec];
    if (!es) return undefined;
    v = normalize(v);
    let t = typeOf(v);
    let k = t ? typeKind(t) : undefined;
    let s;
    try {
        if (k === "pointer") s = readCString(v.address, es, MAX_DISPLAY_STRING);
        else if (k === "array") s = readFixedString(v.targetLocation, es, Math.min(MAX_DISPLAY_STRING, Math.floor(safe(() => num(t.size), 0) / es)));
        else if (typeof v === "number" || isInt64(v)) s = readCString(isInt64(v) ? v : int64(v.toString(16)), es, MAX_DISPLAY_STRING);
        else return undefined;
    } catch (e) {
        return "<Error reading characters of string>";
    }
    return spec.charAt(spec.length - 1) === "b" ? s : (es === 2 ? "L" : "") + quote(s);
}

function parseFormat(expr) {
    let m = FORMAT.exec(expr);
    if (!m) return { expr: expr };
    return { expr: m[1], spec: m[2] };
}

function evaluateValue(text, opts) {
    let f = parseFormat(text);
    let expr = f.expr;
    let hex = opts.hex;
    let raw = false;
    if (f.spec === "x" || f.spec === "X" || f.spec === "h") hex = true;
    if (f.spec === "d") hex = false;
    if (f.spec === "!") raw = true;
    let direct;
    // The expression VS Code reuses (Add to Watch...) keeps its spelling: it resolves the same way
    // again, where the rewritten one would freeze register values and addresses.
    let evalExpr;
    if (opts.lookup) {
        if (opts.hover) checkSideEffects(scanTokens(expr));
        let scope = safe(() => frameScope(opts.tid, opts.frame), undefined);
        if (scope) {
            currentFrameModule = scope.module;
            let rw = rewriteNames(expr, nameLookup(scope, opts.lookup === "strict", !opts.hover));
            if (rw.expr !== expr) evalExpr = expr;
            expr = rw.expr;
            direct = rw.value;
        }
    }
    let v = direct !== undefined ? direct : host.evaluateExpression(expr);
    let hint;
    let addr;
    if (f.spec !== undefined && /^\[?\d+\]?$/.test(f.spec)) {
        let n = parseInt(f.spec.replace(/[\[\]]/g, ""), 10);
        let t = typeOf(v);
        if (!t || typeKind(t) !== "pointer") throw new Error("A count format specifier needs a pointer");
        let base = typeName(t.baseType);
        expr = "*(" + base + "(*)[" + n + "])(" + expr + ")";
        evalExpr = undefined;
        v = host.evaluateExpression(expr);
    }
    if (v === null || typeof v !== "object" || isInt64(v)) {
        try {
            let p = host.evaluateExpression("&(" + expr + ")");
            hint = p.targetType.baseType;
            addr = hexOf(p.address);
        } catch (err) { /* not an lvalue */ }
    }
    return { v: v, hint: hint, addr: addr, hex: hex, raw: raw, expr: evalExpr || expr, spec: f.spec };
}

// -------------------------------------------------------- C++ exception info

const PRIMITIVE_TYPE_CODES = {
    ".H": "int", ".I": "unsigned int", ".D": "char", ".E": "unsigned char", ".C": "signed char", ".F": "short",
    ".G": "unsigned short", ".J": "long", ".K": "unsigned long", ".M": "float", ".N": "double", ".O": "long double",
    "._J": "__int64", "._K": "unsigned __int64", "._N": "bool", "._W": "wchar_t",
    ".PEAD": "char *", ".PEBD": "char const *", ".PEA_W": "wchar_t *", ".PEB_W": "wchar_t const *",
    ".PAD": "char *", ".PBD": "char const *", ".PA_W": "wchar_t *", ".PB_W": "wchar_t const *", ".PEAX": "void *", ".PAX": "void *"
};

function undecorateTypeName(s) {
    if (PRIMITIVE_TYPE_CODES[s]) return PRIMITIVE_TYPE_CODES[s];
    let m = /^\.\?A[VUT](.*)$/.exec(s) || /^\.\?AW4(.*)$/.exec(s);
    if (!m) return s;
    let body = m[1];
    if (body.indexOf("?$") >= 0) return s;
    body = body.replace(/@@$/, "").replace(/@$/, "");
    return body.split("@").reverse().join("::");
}

function read32(addr) {
    return num(host.memory.readMemoryValues(addr, 1, 4)[0]);
}

function readPtr(addr, size) {
    let v = host.memory.readMemoryValues(addr, 1, size)[0];
    return isInt64(v) ? v : new host.Int64(num(v));
}

function cppExceptionInfo(req) {
    let params = req.params.map(int64);
    let size = req.params.length >= 4 ? 8 : 4;
    let imageBase = req.params.length >= 4 ? params[3] : undefined;
    let rva = x => imageBase !== undefined ? imageBase.add(x) : new host.Int64(x);
    let objPtr = params[1];
    let throwInfo = params[2];
    let types = [];
    if (throwInfo.compareTo(0) !== 0) {
        let cta = rva(read32(throwInfo.add(12)));
        let n = read32(cta);
        for (let k = 0; k < n && k < 64; k++) {
            try {
                let ct = rva(read32(cta.add(4 + 4 * k)));
                let td = rva(read32(ct.add(4)));
                types.push(undecorateTypeName(host.memory.readString(td.add(2 * size))));
            } catch (err) {
                break;
            }
        }
    }
    let what;
    if (types.indexOf("std::exception") >= 0) {
        what = safe(() => {
            let p = readPtr(objPtr.add(size), size);
            return p.compareTo(0) === 0 ? undefined : host.memory.readString(p);
        }, undefined);
    }
    return { types: types, what: what, object: objPtr.toString(16) };
}

// ------------------------------------------------------------------ strings

function stringOf(v) {
    v = normalize(v);
    let t = typeOf(v);
    if (typeof v === "string") return v;
    if (!t) return String(v);
    let k = typeKind(t);
    if (k === "pointer") {
        let base = t.baseType;
        if (!isCharType(base)) throw new Error("Not a string");
        let s = readCString(v.address, charSize(base));
        return s.length > MAX_VIEW_STRING ? s.substr(0, MAX_VIEW_STRING) : s;
    }
    if (k === "array" && isCharType(t.baseType)) {
        return readFixedString(v.targetLocation, charSize(t.baseType), arrayLength(t));
    }
    let n = typeName(t) || "";
    if (/^std::basic_string</.test(n)) {
        let msvc = safe(() => {
            let val = v._Mypair._Myval2;
            let size = num(val._Mysize);
            let res = num(val._Myres);
            let elem = itemHint(v);
            let es = elem ? charSize(elem) : 1;
            let bufElems = Math.max(1, Math.floor(16 / es));
            let ptr = res < bufElems ? val._Bx._Buf.targetLocation : val._Bx._Ptr.address;
            let len = Math.min(size, MAX_VIEW_STRING);
            return es === 2 ? host.memory.readWideString(ptr, len) : host.memory.readString(ptr, len);
        }, undefined);
        if (msvc !== undefined) return msvc;
    }
    let s = safe(() => v.ToDisplayString("sb"), undefined);
    if (s === undefined) {
        s = String(v);
        let m = /^L?"([\s\S]*)"$/.exec(s);
        if (m) s = m[1];
    }
    return s;
}

// --------------------------------------------------------------------- ops

const ops = {
    ping: () => "pong",

    reset: () => {
        handles.clear();
        rawMemberCache.clear();
        frameScopes.clear();
        currentFrameModule = undefined;
        return true;
    },

    pid: () => num(host.currentProcess.Id),

    modules: () => {
        let out = [];
        for (let m of host.currentProcess.Modules) {
            out.push({
                name: safe(() => String(m.Name), ""),
                base: safe(() => hexOf(m.BaseAddress), "0"),
                size: safe(() => num(m.Size), 0),
                symType: safe(() => m.SymbolType === undefined ? undefined : String(m.SymbolType), undefined),
                symFile: safe(() => m.SymbolSource === undefined ? undefined : String(m.SymbolSource), undefined)
            });
        }
        return out;
    },

    process: () => {
        let main;
        for (let m of host.currentProcess.Modules) {
            main = safe(() => String(m.Name), undefined);
            break;
        }
        return { pid: num(host.currentProcess.Id), main: main };
    },

    threads: () => {
        let out = [];
        for (let t of host.currentProcess.Threads) {
            let name = safe(() => String(t.Name), "");
            out.push({ id: num(t.Id), index: safe(() => num(t.Index), out.length), name: name });
        }
        return { threads: out, current: safe(() => num(host.currentThread.Id), undefined) };
    },

    stack: (req) => {
        let th = findThread(req.tid);
        let start = req.start || 0;
        let levels = req.levels || 1000;
        let out = [];
        let total = 0;
        for (let f of th.Stack.Frames) {
            if (total >= start && out.length < levels) out.push(frameInfo(f, total));
            total++;
            if (total >= 10000) break;
        }
        return { frames: out, total: total };
    },

    where: (req) => {
        let th = host.currentThread;
        let out = [];
        let i = 0;
        for (let f of th.Stack.Frames) {
            if (i >= (req.depth || 8)) break;
            out.push(frameInfo(f, i));
            i++;
        }
        return { tid: num(th.Id), frames: out };
    },

    allStacks: (req) => {
        let out = [];
        let max = req.maxFrames || 200;
        for (let t of host.currentProcess.Threads) {
            let frames = [];
            try {
                let i = 0;
                for (let f of t.Stack.Frames) {
                    if (i >= max) break;
                    frames.push(frameInfo(f, i));
                    i++;
                }
            } catch (err) { /* thread may be exiting */ }
            out.push({ id: num(t.Id), index: safe(() => num(t.Index), out.length), name: safe(() => String(t.Name), ""), frames: frames });
        }
        return { threads: out, current: safe(() => num(host.currentThread.Id), undefined) };
    },

    switchTo: (req) => {
        ensureContext(req.tid, req.frame);
        return true;
    },

    scopes: (req) => {
        let th = findThread(req.tid);
        frameAt(th, req.frame);
        let locals = newHandle({ kind: "locals", tid: req.tid, fi: req.frame });
        let regs = newHandle({ kind: "regs", tid: req.tid });
        return { locals: locals, registers: regs };
    },

    children: (req) => {
        let e = getHandle(req.ref);
        let opts = { hex: !!req.hex };
        let list = () => {
            if (e.kind === "locals") return { vars: localsOf(e, opts) };
            if (e.kind === "regs") return { vars: registersOf(e, opts) };
            if (e.kind === "value") return valueChildren(e, req, opts);
            return { vars: [] };
        };
        currentFrameModule = e.module;
        return e.noLoad ? withoutLoads(list) : list();
    },

    // req.context is the DAP one. Only the Debug Console ("repl") falls back to dbgeng's search of
    // every module for a name the frame does not know; a hover never loads symbols.
    evaluate: (req) => {
        ensureContext(req.tid, req.frame);
        let hover = req.context === "hover";
        let run = () => {
            let r = evaluateValue(req.expr, { hex: !!req.hex, lookup: req.context === "repl" ? "lax" : "strict", hover: hover, tid: req.tid, frame: req.frame });
            if (r.raw) {
                let v = normalize(r.v);
                let res = makeVar(undefined, req.expr, v, r.hint, r.expr, { hex: r.hex, addr: r.addr });
                if (res.ref !== undefined) handles.get(res.ref).raw = true;
                return res;
            }
            let res = makeVar(undefined, req.expr, r.v, r.hint, r.expr, { hex: r.hex, addr: r.addr });
            let str = specString(r.v, r.spec);
            if (str !== undefined) res.value = str;
            return res;
        };
        return hover ? withoutLoads(run) : run();
    },

    setValue: (req) => {
        let e = getHandle(req.ref);
        let c = childOf(e, req.name);
        if (e.kind === "locals") ensureContext(e.tid, e.fi);
        let target;
        if (c.addr !== undefined && c.typeName) target = "*((" + c.typeName + " *)0x" + c.addr + ")";
        else if (c.evalName) target = c.evalName;
        else throw new Error("This value cannot be modified");
        host.evaluateExpression(target + " = " + req.value);
        let nv = host.evaluateExpression(target);
        return makeVar(e, req.name, nv, c.hint, c.evalName, { hex: !!req.hex, addr: c.addr });
    },

    dataInfo: (req) => {
        let c;
        if (req.ref !== undefined) {
            c = childOf(getHandle(req.ref), req.name);
        } else {
            ensureContext(req.tid, req.frame);
            let r = evaluateValue(req.expr, { lookup: "lax", tid: req.tid, frame: req.frame });
            c = { obj: r.v, hint: r.hint, addr: r.addr !== undefined ? r.addr : addressOf(normalize(r.v)) };
        }
        if (!c || c.addr === undefined) throw new Error("The value has no address");
        let size = safe(() => num(typeOf(c.obj).size), undefined);
        if (size === undefined) size = safe(() => num(c.hint.size), undefined);
        if (size === undefined) throw new Error("Unknown value size");
        return { addr: c.addr, size: size };
    },

    readMemory: (req) => {
        let addr = int64(req.addr);
        let remaining = req.count;
        let hex = "";
        let read = 0;
        while (remaining > 0) {
            let pageLeft = 4096 - addr.add(read).bitwiseAnd(4095).asNumber();
            let chunk = Math.min(remaining, pageLeft);
            let bytes;
            try {
                bytes = host.memory.readMemoryValues(addr.add(read), chunk, 1);
            } catch (err) {
                break;
            }
            for (let b of bytes) hex += ("0" + num(b).toString(16)).slice(-2);
            read += chunk;
            remaining -= chunk;
        }
        return { hex: hex, unreadable: req.count - read };
    },

    writeMemory: (req) => {
        let addr = int64(req.addr);
        let values = [];
        for (let i = 0; i < req.hex.length; i += 2) values.push(parseInt(req.hex.substr(i, 2), 16));
        host.memory.writeMemoryValues(addr, values.length, values, 1);
        return { written: values.length };
    },

    cppException: (req) => cppExceptionInfo(req),

    viewString: (req) => {
        let v;
        if (req.ref !== undefined) {
            v = childOf(getHandle(req.ref), req.name).obj;
        } else {
            ensureContext(req.tid, req.frame);
            v = evaluateValue(req.expr, { lookup: "lax", tid: req.tid, frame: req.frame }).v;
        }
        return { text: stringOf(v) };
    },

    format: (req) => {
        // Formats several expressions at once, used by logpoints.
        ensureContext(req.tid, req.frame);
        return req.exprs.map(x => {
            try {
                let r = evaluateValue(x, { lookup: "strict", tid: req.tid, frame: req.frame });
                let str = specString(r.v, r.spec);
                return { ok: true, value: str !== undefined ? str : display(normalize(r.v), r.hint, r.hex, 0) };
            } catch (err) {
                return { ok: false, value: errMsg(err) };
            }
        });
    }
};

function vscwdbg(hex) {
    let res;
    try {
        let req = JSON.parse(decodeHex(hex));
        let op = ops[req.op];
        if (!op) throw new Error("Unknown operation " + req.op);
        res = { ok: true, r: op(req) };
    } catch (e) {
        res = { ok: false, e: errMsg(e) };
    }
    let text = asciiJson(res);
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        host.diagnostics.debugLog(MARK_PART + text.substr(i, CHUNK_SIZE) + "\n");
    }
    host.diagnostics.debugLog(MARK_END + "\n");
}

function initializeScript() {
    return [new host.apiVersionSupport(1, 3), new host.functionAlias(vscwdbg, "vscwdbg")];
}

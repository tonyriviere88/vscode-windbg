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

// Stacks are walked here, not by dbgeng: its walk loads the symbols of every module on the
// stack, even to only read frame addresses, and a stop must not load any. x64 unwinding only
// needs the unwind data of the images (.pdata, .xdata), read from memory. A frame is named from
// the symbols already loaded; in a module without them it shows as module+offset. Inline frames,
// which come from the PDBs, are not shown.

// Registers by their number in x64 unwind codes.
const GPR = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
// Registers a callee preserves: what a frame's context carries over from its callee.
const NONVOLATILE = ["rbx", "rbp", "rsi", "rdi", "r12", "r13", "r14", "r15"];
const MAX_FRAMES = 1000;

// Per stop: the modules, the walked stacks (thread id -> { frames, complete }) and frame names.
let walkModules;
let walkedStacks = new Map();
let frameNames = new Map();
// "tid:frame" whose registers are dbgeng's view (ChangeRegisterContext), or null: the threads' own.
let contextFrame = null;

function walkModuleList() {
    if (!walkModules) {
        walkModules = [];
        for (let m of host.currentProcess.Modules) {
            let base = safe(() => num(m.BaseAddress), undefined);
            if (base === undefined) continue;
            walkModules.push({ obj: m, name: moduleBaseName(safe(() => String(m.Name), "")), base: base, end: base + safe(() => num(m.Size), 0), pdata: undefined });
        }
    }
    return walkModules;
}

function imageAt(addr) {
    for (let m of walkModuleList()) if (addr >= m.base && addr < m.end) return m;
    return null;
}

function readU64(addr) {
    return host.memory.readMemoryValues(addr, 1, 8)[0];
}

function u16(bytes, at) {
    return bytes[at] | (bytes[at + 1] << 8);
}

function s8(b) {
    return b > 127 ? b - 256 : b;
}

function s32(bytes, at) {
    return u32(bytes, at) | 0;
}

// The exception directory (the RUNTIME_FUNCTION table) of a module: { rva, count }, or null.
function pdataOf(m) {
    if (m.pdata === undefined) {
        m.pdata = safe(() => {
            let opt = m.base + read32(m.base + 0x3c) + 24;
            if (num(host.memory.readMemoryValues(opt, 1, 2)[0]) !== 0x20b) return null;
            let dir = opt + 112 + 3 * 8;
            let rva = read32(dir);
            let size = read32(dir + 4);
            return rva && size >= 12 ? { rva: rva, count: Math.floor(size / 12) } : null;
        }, null);
    }
    return m.pdata;
}

function runtimeFunction(m, at) {
    let e = host.memory.readMemoryValues(m.base + at, 3, 4);
    return { begin: num(e[0]), end: num(e[1]), unwind: num(e[2]) };
}

// The RUNTIME_FUNCTION covering addr (RVAs), or null: a leaf function, which has none.
function functionEntry(m, addr) {
    let p = pdataOf(m);
    if (!p) return null;
    let rel = addr - m.base;
    let lo = 0;
    let hi = p.count - 1;
    while (lo <= hi) {
        let mid = (lo + hi) >> 1;
        let e = runtimeFunction(m, p.rva + 12 * mid);
        if (rel < e.begin) hi = mid - 1;
        else if (rel >= e.end) lo = mid + 1;
        // An odd unwind RVA points at the primary entry of the function.
        else return (e.unwind & 1) ? runtimeFunction(m, e.unwind & ~1) : e;
    }
    return null;
}

function unwindInfo(m, rva) {
    let h = targetBytes(m.base + rva, 4);
    let count = h[2];
    let info = {
        version: h[0] & 7, flags: h[0] >> 3, prolog: h[1], count: count, frameReg: h[3] & 15, frameOffset: h[3] >> 4,
        codes: count ? targetBytes(m.base + rva + 4, 2 * count) : [], chained: null
    };
    if (info.flags & 4) {
        let c = targetBytes(m.base + rva + 4 + 2 * (count + (count & 1)), 12);
        info.chained = { begin: u32(c, 0), end: u32(c, 4), unwind: u32(c, 8) };
    }
    return info;
}

function codeSlots(op, opInfo) {
    switch (op) {
        case 1: return opInfo === 0 ? 2 : 3;
        case 4: case 6: case 8: return 2;
        case 5: case 7: case 9: return 3;
        default: return 1;
    }
}

// True when the prolog had established the frame register `offset` bytes into the function.
function framePointerSet(info, offset) {
    for (let i = 0; i < info.count; i += codeSlots(info.codes[2 * i + 1] & 15, info.codes[2 * i + 1] >> 4)) {
        if ((info.codes[2 * i + 1] & 15) === 3) return offset >= info.codes[2 * i];
    }
    return false;
}

// Undoes the prolog operations that ran `offset` bytes into the function (all of them for a
// chained entry). ctx.rsp is the frame base. True after a machine frame, which restores rip too.
function undoProlog(info, offset, ctx) {
    let machine = false;
    for (let i = 0; i < info.count;) {
        let at = info.codes[2 * i];
        let op = info.codes[2 * i + 1] & 15;
        let opInfo = info.codes[2 * i + 1] >> 4;
        let slot = k => u16(info.codes, 2 * (i + k));
        // In version 2, op 6 describes an epilog: nothing to undo.
        if (offset >= at && !(info.version === 2 && op === 6)) {
            switch (op) {
                case 0: ctx.regs[GPR[opInfo]] = readU64(ctx.rsp); ctx.rsp += 8; break;
                case 1: ctx.rsp += opInfo === 0 ? slot(1) * 8 : slot(1) + slot(2) * 65536; break;
                case 2: ctx.rsp += opInfo * 8 + 8; break;
                case 4: ctx.regs[GPR[opInfo]] = readU64(ctx.rsp + slot(1) * 8); break;
                case 5: ctx.regs[GPR[opInfo]] = readU64(ctx.rsp + slot(1) + slot(2) * 65536); break;
                case 10: {
                    let frame = ctx.rsp + (opInfo ? 8 : 0);
                    ctx.rip = num(readU64(frame));
                    ctx.rsp = num(readU64(frame + 24));
                    machine = true;
                    break;
                }
                // 3 (frame register): applied before, as the frame base. 6-9: XMM registers.
            }
        }
        i += codeSlots(op, opInfo);
    }
    return machine;
}

// When rip is in an epilog, runs the rest of it like Windows does (the prolog's unwind codes no
// longer describe the stack there). True when it was one; next is then the caller's context.
function leaveEpilog(m, fe, info, ctx, next) {
    let b = safe(() => targetBytes(ctx.rip, 64), null);
    if (!b) return false;
    let i = 0;
    let rsp = ctx.rsp;
    let regs = Object.assign({}, ctx.regs);
    if (b[0] === 0x48 && b[1] === 0x83 && b[2] === 0xc4) {
        rsp += b[3];
        i = 4;
    } else if (b[0] === 0x48 && b[1] === 0x81 && b[2] === 0xc4) {
        rsp += s32(b, 3);
        i = 7;
    } else if ((b[0] & 0xfe) === 0x48 && b[1] === 0x8d && ((b[2] >> 3) & 7) === 4) {
        // lea rsp, [frame register + displacement]
        let rm = (b[2] & 7) + (b[0] & 1 ? 8 : 0);
        let mod = b[2] >> 6;
        if (!info.frameReg || rm !== info.frameReg || (mod !== 1 && mod !== 2)) return false;
        rsp = num(regs[GPR[rm]]) + (mod === 1 ? s8(b[3]) : s32(b, 3));
        i = mod === 1 ? 4 : 7;
    }
    for (;;) {
        if (b[i] >= 0x58 && b[i] <= 0x5f) {
            regs[GPR[b[i] - 0x58]] = readU64(rsp);
            i += 1;
        } else if (b[i] === 0x41 && b[i + 1] >= 0x58 && b[i + 1] <= 0x5f) {
            regs[GPR[8 + b[i + 1] - 0x58]] = readU64(rsp);
            i += 2;
        } else {
            break;
        }
        rsp += 8;
        if (i > 48) return false;
    }
    let outside = target => target < m.base + fe.begin || target >= m.base + fe.end;
    let c = b[i];
    let end = c === 0xc3 || c === 0xc2 || (c === 0xf3 && b[i + 1] === 0xc3) ||
        (c === 0xe9 && outside(ctx.rip + i + 5 + s32(b, i + 1))) ||
        (c === 0xeb && outside(ctx.rip + i + 2 + s8(b[i + 1]))) ||
        (c === 0xff && b[i + 1] === 0x25) ||
        (c === 0x48 && b[i + 1] === 0xff && (b[i + 2] & 0x38) === 0x20);
    if (!end) return false;
    next.regs = regs;
    next.rip = num(readU64(rsp));
    next.rsp = rsp + 8;
    return true;
}

// The context of the caller of the frame whose context is ctx.
function callerContext(ctx) {
    let next = { rip: 0, rsp: ctx.rsp, regs: Object.assign({}, ctx.regs) };
    let m = imageAt(ctx.rip);
    let fe = m ? functionEntry(m, ctx.rip) : null;
    if (!fe) {
        // A leaf function: no prolog, the return address is at rsp.
        next.rip = num(readU64(ctx.rsp));
        next.rsp = ctx.rsp + 8;
        return next;
    }
    let info = unwindInfo(m, fe.unwind);
    let offset = ctx.rip - (m.base + fe.begin);
    if (offset >= info.prolog && leaveEpilog(m, fe, info, ctx, next)) return next;
    let machine = false;
    for (let depth = 0; info && depth < 32; depth++) {
        let ran = depth === 0 ? offset : Infinity;
        if (info.frameReg && framePointerSet(info, ran)) next.rsp = num(next.regs[GPR[info.frameReg]]) - 16 * info.frameOffset;
        machine = undoProlog(info, ran, next) || machine;
        info = info.chained ? unwindInfo(m, info.chained.unwind) : null;
    }
    if (!machine) {
        next.rip = num(readU64(next.rsp));
        next.rsp += 8;
    }
    return next;
}

// The frame contexts { rip, rsp, regs } of a thread, at least `depth` of them when it has them.
function walkThread(th, depth) {
    let tid = num(th.Id);
    let w = walkedStacks.get(tid);
    if (w && (w.complete || w.frames.length >= depth)) return w.frames;
    // The thread's own registers, not a frame's view set by ensureContext.
    if (contextFrame !== null && contextFrame.split(":")[0] === String(tid)) resetContext();
    let regs = th.Registers.User;
    let ctx = { rip: num(regs.rip), rsp: num(regs.rsp), regs: {} };
    for (let n of NONVOLATILE) ctx.regs[n] = safe(() => regs[n], 0);
    let frames = [];
    let complete = false;
    let limit = Math.max(depth, Math.min(MAX_FRAMES, 2 * depth));
    while (frames.length < limit) {
        frames.push(ctx);
        let next = safe(() => callerContext(ctx), null);
        if (!next || !next.rip || next.rsp <= ctx.rsp || !imageAt(next.rip)) {
            complete = true;
            break;
        }
        ctx = next;
    }
    walkedStacks.set(tid, { frames: frames, complete: complete || frames.length >= MAX_FRAMES });
    return frames;
}

let disassembler;

// Function, file and line at addr in a module whose symbols are loaded (nothing gets loaded).
function sourceAt(addr) {
    if (!disassembler) disassembler = host.namespace.Debugger.Utility.Code.CreateDisassembler();
    let si = safe(() => {
        for (let ins of disassembler.DisassembleInstructions(addr)) return ins.SourceInformation;
    }, undefined);
    let fn = si ? safe(() => si.FunctionName === undefined ? undefined : String(si.FunctionName), undefined) : undefined;
    if (!fn) return undefined;
    return {
        // Public symbols come with the '@' that dbgeng's frames leave out ("@ILT+1650(...)").
        fn: fn.replace(/^@/, ""),
        at: safe(() => num(si.FunctionAddress), undefined),
        file: safe(() => si.SourceFile === undefined ? undefined : String(si.SourceFile), undefined),
        line: safe(() => si.SourceLine === undefined ? undefined : num(si.SourceLine), undefined)
    };
}

function frameInfo(ctx, i) {
    let key = ctx.rip + ":" + (i > 0);
    let named = frameNames.get(key);
    if (!named) {
        named = { text: "0x" + hexOf(ctx.rip) };
        let m = imageAt(ctx.rip);
        if (m) {
            named.mod = m.name;
            named.text = m.name + "+0x" + (ctx.rip - m.base).toString(16);
            if (safe(() => String(m.obj.SymbolType), "Deferred") !== "Deferred") {
                // A return address names the call before it.
                let s = (i > 0 ? sourceAt(ctx.rip - 1) : undefined) || sourceAt(ctx.rip);
                if (s) {
                    named.fn = s.fn;
                    named.text = m.name + "!" + s.fn + (s.at !== undefined && ctx.rip > s.at ? "+0x" + (ctx.rip - s.at).toString(16) : "");
                    named.file = s.file;
                    named.line = s.line;
                }
            }
        }
        frameNames.set(key, named);
    }
    let r = { i: i, ip: hexOf(ctx.rip), sp: hexOf(ctx.rsp), inl: false, text: named.text };
    if (named.mod) r.mod = named.mod;
    if (named.fn) r.fn = named.fn;
    if (named.file) r.file = named.file;
    if (named.line !== undefined) r.line = named.line;
    return r;
}

function frameContext(tid, fi) {
    let frames = walkThread(findThread(tid), fi + 1);
    if (fi >= frames.length) throw new Error("Frame " + fi + " not found");
    return frames[fi];
}

function resetContext() {
    if (contextFrame === null) return;
    commandLines(".cxr");
    contextFrame = null;
}

// Makes a frame the debugger's scope, for locals and expressions: frame 0 is the thread's own
// registers, another frame its unwound rip, rsp and rbp as dbgeng's view (like .cxr: the thread
// itself is unchanged). ChangeRegisterContext takes no other register: the other nonvolatile
// ones keep the thread's values, which only matters for a local held in one in optimized code.
function ensureContext(tid, frame) {
    if (tid === undefined || tid === null) return;
    let fi = frame || 0;
    if (num(host.currentThread.Id) !== tid) {
        resetContext();
        findThread(tid).SwitchTo();
    }
    let key = tid + ":" + fi;
    if (contextFrame === key || (fi === 0 && contextFrame === null)) return;
    if (fi === 0) {
        resetContext();
        return;
    }
    let c = frameContext(tid, fi);
    host.namespace.Debugger.Utility.Control.ChangeRegisterContext(true, c.rip, c.rsp, c.regs.rbp);
    contextFrame = key;
}

// Names of the parameters and locals of the current scope (ensureContext), from `x /1 *`: the
// data model's frame objects would make dbgeng walk the stack, and `dv` prints the values, which
// loads the symbols that describe their dynamic types.
function scopeNames() {
    let out = [];
    let seen = new Set();
    for (let line of commandLines("x /1 *")) {
        let name = line.trim();
        if (/^[A-Za-z_$<][^\s]*$/.test(name) && !seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    }
    return out;
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

// Field names in the order the data model lists them: own fields first, then each base class.
function orderedFieldNames(t) {
    let names = [];
    let visit = (ty, depth) => {
        if (!ty || depth > 16) return;
        let fields = safe(() => ty.fields, undefined);
        if (fields) for (let n of propNames(fields)) names.push(n);
        for (let b of baseClasses(ty)) visit(safe(() => b.type, undefined), depth + 1);
    };
    visit(t, 0);
    return names;
}

// Index of the first raw property in `props`. The data model lists the natvis items first, then
// ToDisplayString when the visualizer has a DisplayString, then the raw fields mixed with the enumerators
// of nested enums (which are no fields). A natvis item named like a field replaces that field, so names
// cannot tell items from fields; the order can.
function rawTailStart(t, props) {
    let td = props.indexOf("ToDisplayString");
    if (td >= 0) return td;
    let order = orderedFieldNames(t);
    let rank = new Map();
    order.forEach((n, i) => { if (!rank.has(n)) rank.set(n, i); });
    for (let i = 0; i < props.length; i++) {
        let j = rank.get(props[i]);
        if (j === undefined) continue;
        // The raw tail lists the fields in declaration order (a field replaced by an item is listed before it):
        // no field declared before props[i] may be listed after i, and the next field listed must be the next
        // declared one still listed after i.
        if (order.slice(0, j).some((n) => props.indexOf(n, i + 1) > i)) continue;
        let next = undefined;
        for (let k = i + 1; k < props.length && next === undefined; k++) if (rank.has(props[k])) next = props[k];
        let expected = undefined;
        for (let m = j + 1; m < order.length && expected === undefined; m++) if (props.indexOf(order[m], i + 1) > i) expected = order[m];
        if (next === expected) return i;
    }
    return props.length;
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
    let out = [];
    // A frame without private symbols (no source line) has none: dbgeng's scope would still be the
    // one of the last frame that had them, whose locals `x` would list.
    let frame = safe(() => frameInfo(frameContext(num(findThread(e.tid).Id), e.fi || 0), e.fi || 0), undefined);
    if (!frame || !frame.file) return out;
    for (let name of scopeNames()) {
        if (name.charAt(0) === "<") continue;
        let v;
        try { v = host.evaluateExpression(name); } catch (err) { out.push({ name: name, value: "<" + errMsg(err) + ">" }); continue; }
        if (typeof v === "function") continue;
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
    for (let name of props.slice(0, rawTailStart(t, props))) {
        if (META.has(name)) continue;
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
        let after = new Set(readModules().filter(m => m.deferred).map(m => m.name));
        // Only the modules still deferred: dbgeng may have loaded one meanwhile.
        let needed = symbolHints.filter(h => after.has(h.module));
        if (needed.length > 0) r.needSymbols = needed;
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

// withoutLoads for a call whose caller only knows success or failure.
function noLoads(f) {
    let r = withoutLoads(f);
    if (r && r.failed !== undefined) throw new Error(r.failed);
    return r;
}

// "module!name", "module.dll!Type" (a cast included) or "{,,module.dll}name": dbgeng loads the
// symbols of that module to evaluate it. With symbol loading forbidden, a module whose symbols are
// deferred fails the expression before dbgeng sees it.
const MODULE_QUALIFIER = /([A-Za-z_]\w*)(?:\.(?:dll|exe))?!(?=[A-Za-z_:~])/gi;

function checkModuleNames(expr) {
    if (!noLoad) return;
    let text = expr.replace(VS_CONTEXT, (m, mod) => moduleBaseName(mod.trim().replace(/^"|"$/g, "")) + "!");
    // String and character literals hold no names.
    text = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
    let table = moduleTable();
    let m;
    MODULE_QUALIFIER.lastIndex = 0;
    while ((m = MODULE_QUALIFIER.exec(text)) !== null) {
        let mod = moduleNamed(table, m[1]);
        if (mod && mod.deferred) {
            addSymbolHint({ module: mod.name });
            throw new Error("Symbols for " + mod.name + " are not loaded");
        }
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
const MODULE_FILE_QUALIFIER = /\b([A-Za-z_]\w*)\.(?:dll|exe)!(?=[A-Za-z_:~])/gi;

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
    // Visual Studio's "module.dll!name": dbgeng names the module without its extension.
    expr = expr.replace(MODULE_FILE_QUALIFIER, "$1!");
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
        // A type, module-qualified ones included ("(plugin!app::Shape*)p"), is dbgeng's to resolve.
        if ((!module && CPP_KEYWORDS.has(parts[0])) || isTypePosition(toks, first, i)) continue;
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
    let names = new Set(scopeNames());
    let members = new Set();
    if (names.has("this")) {
        let t = safe(() => host.evaluateExpression("this").targetType.baseType, undefined);
        if (t) members = rawMemberNames(t);
    }
    let frame = safe(() => frameInfo(frameContext(tid === undefined || tid === null ? num(host.currentThread.Id) : tid, fi || 0), fi || 0), undefined);
    let fn = frame ? frame.fn : undefined;
    let module = frame && frame.fn ? frame.mod : undefined;
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
    checkModuleNames(expr);
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

// ------------------------------------------------ local symbols, pending breakpoints

// Source and function breakpoints are only ever set qualified with a module whose PDB is loaded:
// unqualified, dbgeng loads the PDB of every module until it finds the file or the function.
// The ones no loaded PDB contains wait here: id -> { command, module, tried }. `command` has
// MODULE_SLOT where the module name goes; `module`, when set, is the only module to try; `tried`
// holds the modules already tried.
let pendingBps = new Map();
const MODULE_SLOT = "@@MODULE@@";
// Symbol loading at module load: `local` loads the PDB next to the image (modules passing
// include/exclude), `always` the modules matching it from the whole symbol path.
let autoLoad = { local: false, include: [], exclude: [], always: [], program: undefined };
// The symbol path in use is `localPath`: nothing reached over the network, so that what dbgeng
// loads on its own (the module a stop is in) never waits on a server. `fullPath`, with the symbol
// servers, is only used by explicit loads (withFullPath).
let symbolPaths = { localPath: "", fullPath: "" };
// Drive letters (upper case) mapped to network shares.
let networkDrives = new Set();
// Printed while the target runs, when a module load bound a pending breakpoint.
const MARK_BOUND = "@@WDBGBOUND@@";

function commandLines(command) {
    let out = [];
    for (let line of host.namespace.Debugger.Utility.Control.ExecuteCommand(command)) out.push(String(line));
    return out;
}

function hasLoadedPdb(m) {
    let t = safe(() => String(m.SymbolType), "");
    return /^(pdb|sym)|dia|codeview/i.test(t);
}

// Modules whose PDB is loaded, optionally only the one at `base`.
function pdbModules(base) {
    let out = [];
    for (let m of host.currentProcess.Modules) {
        let b = safe(() => num(m.BaseAddress), undefined);
        if (b === undefined || (base !== undefined && b !== base)) continue;
        if (hasLoadedPdb(m)) out.push({ name: moduleBaseName(safe(() => String(m.Name), "")), base: b });
    }
    return out;
}

// Tries a pending breakpoint in the modules it was not tried in yet; returns how it bound, or null.
function bindIn(id, bp, modules) {
    for (let m of modules) {
        let key = m.name.toLowerCase() + "@" + m.base;
        if (bp.tried.has(key) || (bp.module && bp.module.toLowerCase() !== m.name.toLowerCase())) continue;
        bp.tried.add(key);
        let output = commandLines(bp.command.split(MODULE_SLOT).join(m.name)).join("\n");
        let listing = commandLines("bl " + id).join("\n");
        let row = new RegExp("^\\s*" + id + "\\s+[ed](u?)\\s", "m").exec(listing);
        if (row && !row[1]) {
            pendingBps.delete(id);
            return { id: id, module: m.name, output: output, listing: listing };
        }
        commandLines("bc " + id);
    }
    return null;
}

function bindPending(modules) {
    let bound = [];
    for (let [id, bp] of Array.from(pendingBps)) {
        let b = bindIn(id, bp, modules);
        if (b) bound.push(b);
    }
    return bound;
}

function autoLoadWanted(name) {
    if (!autoLoad.local) return false;
    if (autoLoad.include.length > 0 && !autoLoad.include.some(r => r.test(name))) return false;
    return !autoLoad.exclude.some(r => r.test(name));
}

function alwaysLoadWanted(name) {
    return autoLoad.always.some(r => r.test(name));
}

function setSymbolPath(p) {
    // An empty path would make dbgeng look for _NT_SYMBOL_PATH again.
    commandLines(".sympath " + (p || "cache*"));
}

function loadedPdbNames() {
    return pdbModules().map(m => m.name);
}

// Any change of the symbol path makes dbgeng drop the symbols it got from a symbol store (the
// local cache included): the modules in `keep` that lost theirs load them again, from `p`.
function changeSymbolPath(p, keep) {
    setSymbolPath(p);
    let now = new Set(loadedPdbNames().map(n => n.toLowerCase()));
    for (let n of new Set(keep)) {
        if (!now.has(n.toLowerCase())) commandLines("ld " + n);
    }
}

// Runs f with the symbol servers in the symbol path, after `folders` (the local folders the PDBs
// were built in). What f downloads lands in the cache, where the local path finds it again.
function withFullPath(f, folders) {
    let extra = [];
    for (let d of folders || []) {
        if (d && !extra.some(x => x.toLowerCase() === d.toLowerCase())) extra.push(d);
    }
    let full = extra.concat(symbolPaths.fullPath ? [symbolPaths.fullPath] : []).join(";");
    if (full === symbolPaths.localPath) return f();
    let before = loadedPdbNames();
    setSymbolPath(full);
    try {
        return f();
    } finally {
        changeSymbolPath(symbolPaths.localPath, before.concat(loadedPdbNames()));
    }
}

// Loads a module's symbols at its load: the local PDB, else from the whole symbol path when the
// module is to be always loaded. True when something was loaded.
function loadAtModuleLoad(image, name, base) {
    if (autoLoadWanted(name) && loadLocalPdb(image, name, base)) return true;
    if (!alwaysLoadWanted(name)) return false;
    withFullPath(() => commandLines("ld " + name), [buildPdbFolder(base)]);
    return true;
}

function u32(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function targetBytes(addr, count) {
    let out = [];
    for (let b of host.memory.readMemoryValues(addr, count, 1)) out.push(num(b));
    return out;
}

// The PDB identity an image was linked with (its CodeView RSDS record): { guid, age, path }, or
// null. path is the PDB the linker wrote, as it named it.
function imageCodeView(base) {
    let opt = base + read32(base + 0x3c) + 24;
    let pe64 = num(host.memory.readMemoryValues(opt, 1, 2)[0]) === 0x20b;
    let debugDir = opt + (pe64 ? 112 : 96) + 6 * 8;
    let rva = read32(debugDir);
    let size = read32(debugDir + 4);
    for (let at = 0; rva && at + 28 <= size && at < 28 * 64; at += 28) {
        let entry = targetBytes(base + rva + at, 28);
        let data = u32(entry, 20);
        if (u32(entry, 12) !== 2 || !data) continue;
        let cv = targetBytes(base + data, 24);
        if (u32(cv, 0) === 0x53445352) return { guid: cv.slice(4, 20), age: u32(cv, 20), path: safe(() => cvPath(base + data + 24), "") };
    }
    return null;
}

// The null-terminated UTF-8 path at addr.
function cvPath(addr) {
    let bytes = [];
    for (let b of targetBytes(addr, 520)) {
        if (b === 0) break;
        bytes.push(b);
    }
    let pct = bytes.map(b => "%" + ("0" + b.toString(16)).slice(-2)).join("");
    return safe(() => decodeURIComponent(pct), String.fromCharCode.apply(null, bytes));
}

// A location reached over the network: a UNC path or a mapped network drive.
function isRemoteLocation(p) {
    if (/^(\\\\|\/\/)/.test(p)) return true;
    let d = /^([A-Za-z]):/.exec(p);
    return !!d && networkDrives.has(d[1].toUpperCase());
}

// The folder of the PDB the module at base was built with, when it is local; undefined otherwise.
// dbgeng ignores that path (SYMOPT_IGNORE_CVREC), so that what it loads on its own never waits on a
// build server share: explicit loads put the local folder in the symbol path instead. Changing the
// option per load is no way out: any .symopt change makes dbgeng drop the PDBs loaded from folders.
function buildPdbFolder(base) {
    let cv = base === undefined ? null : safe(() => imageCodeView(base), null);
    if (!cv || !cv.path) return undefined;
    let dir = cv.path.replace(/[\\/][^\\/]*$/, "");
    return dir && dir !== cv.path && !isRemoteLocation(dir) ? dir : undefined;
}

// Loads symbols on request: req.command for req.module, or for every deferred module when it is "*".
function explicitLoad(req) {
    let targets = readModules().filter(m => req.module === "*" ? m.deferred : m.name.toLowerCase() === moduleBaseName(req.module).toLowerCase());
    return withFullPath(() => commandLines(req.command).join("\n"), targets.map(m => buildPdbFolder(m.base)));
}

// The identity of a PDB file (MSF 7.00): the GUID of its PDB stream and the ages of its PDB and
// DBI streams. Null when the file is not a PDB.
function pdbIdentity(path) {
    let f = host.namespace.Debugger.Utility.FileSystem.OpenFile(path);
    try {
        let read = (at, count) => {
            f.Position = at;
            let out = [];
            for (let b of f.ReadBytes(count)) out.push(b);
            return out;
        };
        let header = read(0, 0x38);
        if (String.fromCharCode.apply(null, header.slice(0, 24)) !== "Microsoft C/C++ MSF 7.00") return null;
        let blockSize = u32(header, 0x20);
        let dirBlockCount = Math.ceil(u32(header, 0x2c) / blockSize);
        let map = read(u32(header, 0x34) * blockSize, dirBlockCount * 4);
        let dirBlocks = [];
        for (let i = 0; i < dirBlockCount; i++) dirBlocks.push(u32(map, 4 * i));
        // Reads `count` bytes at `at` of the stream made of `blocks`.
        let readStream = (blocks, at, count) => {
            let out = [];
            while (count > 0) {
                let inBlock = at % blockSize;
                let n = Math.min(count, blockSize - inBlock);
                out = out.concat(read(blocks[Math.floor(at / blockSize)] * blockSize + inBlock, n));
                at += n;
                count -= n;
            }
            return out;
        };
        let streams = u32(readStream(dirBlocks, 0, 4), 0);
        if (streams < 4) return null;
        let sizes = readStream(dirBlocks, 4, 4 * streams);
        let blockCount = (s) => {
            let size = u32(sizes, 4 * s);
            return size === 0xffffffff ? 0 : Math.ceil(size / blockSize);
        };
        let streamBlocks = (s) => {
            let at = 4 + 4 * streams;
            for (let k = 0; k < s; k++) at += 4 * blockCount(k);
            let list = readStream(dirBlocks, at, 4 * blockCount(s));
            let out = [];
            for (let i = 0; i < list.length; i += 4) out.push(u32(list, i));
            return out;
        };
        let info = readStream(streamBlocks(1), 0, 28);
        let dbi = readStream(streamBlocks(3), 0, 12);
        return { guid: info.slice(12, 28), ages: [u32(info, 8), u32(dbi, 8)] };
    } finally {
        f.Close();
    }
}

// True when the PDB is the one the image was linked with: dbgeng would reject any other and go
// on searching the whole symbol path, symbol servers included.
function pdbMatches(base, pdb) {
    let cv = safe(() => imageCodeView(base), null);
    let id = cv ? safe(() => pdbIdentity(pdb), null) : null;
    return !!id && id.guid.every((b, i) => b === cv.guid[i]) && id.ages.indexOf(cv.age) >= 0;
}

// Loads the PDB next to the image when it is the image's own; true when it was loaded. An image on
// a share is left alone: looking at its folder would wait on the network at every module load.
function loadLocalPdb(image, name, base) {
    let dir = image.replace(/[\\/][^\\/]*$/, "");
    let pdb = image.replace(/\.[^.\\/]*$/, "") + ".pdb";
    if (dir === image || isRemoteLocation(image)) return false;
    if (!safe(() => host.namespace.Debugger.Utility.FileSystem.FileExists(pdb), false) || !pdbMatches(base, pdb)) return false;
    // dbgeng finds it next to the image once the (local) symbol path is searched. The symbol path
    // is left alone: any change of it makes dbgeng drop the symbols it got from the symbol cache.
    commandLines("ld " + name);
    return true;
}

// Run by the `ld` event filter at every module load, before cdb resumes the target. It must never
// throw: that would cancel the `gc` that follows it.
function onModuleLoad() {
    try {
        if (!autoLoad.local && autoLoad.always.length === 0) return;
        let ev = null;
        for (let line of commandLines(".lastevent")) {
            let m = /Load module (.+) at ([0-9a-f`]+)\s*$/i.exec(line);
            if (m) ev = { image: m[1].trim(), base: parseInt(m[2].replace(/`/g, ""), 16) };
        }
        if (!ev) return;
        let name = moduleBaseName(ev.image);
        if (!loadAtModuleLoad(ev.image, name, ev.base) || pendingBps.size === 0) return;
        for (let b of bindPending(pdbModules(ev.base))) {
            host.diagnostics.debugLog(MARK_BOUND + asciiJson(b) + "\n");
        }
    } catch (e) {
        // A failed load leaves the module deferred.
    }
}

// ------------------------------------------------------------------ steps
//
// dbgeng loads the symbols of the module it stops in, and of the caller's, whatever stopped it.
// With Just My Code, Step Into must therefore never stop in code whose symbols are deferred: a call
// into it is stepped over, as external code (Visual Studio does the same with "load only specified
// modules"). The decision needs the calls of the current line and their targets, read here without
// loading anything.

const MAX_LINE_INSTRUCTIONS = 4000;

function disassemblerOf() {
    if (!disassembler) disassembler = host.namespace.Debugger.Utility.Code.CreateDisassembler();
    return disassembler;
}

// The instruction at addr, in code whose symbols are loaded (dbgeng names its operands).
function instructionAt(addr) {
    for (let ins of disassemblerOf().DisassembleInstructions(addr)) return instructionInfo(ins);
    return null;
}

function instructionInfo(ins) {
    let a = ins.Attributes;
    let bytes = [];
    for (let b of ins.CodeBytes) bytes.push(num(b));
    let si = safe(() => ins.SourceInformation, undefined);
    return {
        addr: num(ins.Address),
        len: num(ins.Length),
        bytes: bytes,
        isCall: !!safe(() => a.IsCall, false),
        isRet: !!safe(() => a.IsReturn, false),
        isBranch: !!safe(() => a.IsBranch, false),
        isConditional: !!safe(() => a.IsConditional, false),
        line: si ? safe(() => si.SourceLine === undefined ? undefined : num(si.SourceLine), undefined) : undefined,
        fn: si ? safe(() => si.FunctionAddress === undefined ? undefined : num(si.FunctionAddress), undefined) : undefined
    };
}

// The opcode position after the legacy and REX prefixes, and the REX byte (0 when none).
function opcodeStart(b) {
    let i = 0;
    let rex = 0;
    while (i < b.length && [0x66, 0x67, 0xf2, 0xf3, 0x2e, 0x3e].indexOf(b[i]) >= 0) i++;
    if (i < b.length && b[i] >= 0x40 && b[i] <= 0x4f) rex = b[i++];
    return { i: i, rex: rex };
}

function rel32(b, at) {
    return u32(b, at) | 0;
}

function signed8(v) {
    return v > 127 ? v - 256 : v;
}

// The target of a direct call or jump (E8, E9, EB, Jcc, LOOP/JRCXZ), or undefined.
function directTarget(ins) {
    let b = ins.bytes;
    let o = opcodeStart(b);
    let op = b[o.i];
    let next = ins.addr + ins.len;
    if (op === 0xe8 || op === 0xe9) return next + rel32(b, o.i + 1);
    if (op === 0xeb || (op >= 0x70 && op <= 0x7f) || (op >= 0xe0 && op <= 0xe3)) return next + signed8(b[o.i + 1]);
    if (op === 0x0f && b[o.i + 1] >= 0x80 && b[o.i + 1] <= 0x8f) return next + rel32(b, o.i + 2);
    return undefined;
}

const REGISTERS_BY_NUMBER = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];

// The target of a call (direct, or FF /2 through a register or memory, computed with the thread's
// registers when `regs` is given; undefined when it depends on them and they are not).
function callTarget(ins, regs) {
    let direct = directTarget(ins);
    if (direct !== undefined) return direct;
    let b = ins.bytes;
    let o = opcodeStart(b);
    if (b[o.i] !== 0xff) return undefined;
    let p = o.i + 1;
    let modrm = b[p++];
    let mod = modrm >> 6;
    let rm = modrm & 7;
    let reg = n => num(regs[REGISTERS_BY_NUMBER[n]]);
    if (mod === 0 && rm === 5) return num(readU64(ins.addr + ins.len + rel32(b, p)));
    if (!regs) return undefined;
    if (mod === 3) return reg(rm | (o.rex & 1 ? 8 : 0));
    let ea;
    if (rm === 4) {
        let sib = b[p++];
        let index = ((sib >> 3) & 7) | (o.rex & 2 ? 8 : 0);
        let base = (sib & 7) | (o.rex & 1 ? 8 : 0);
        ea = index === 4 ? 0 : reg(index) * (1 << (sib >> 6));
        if ((sib & 7) === 5 && mod === 0) {
            ea += rel32(b, p);
            p += 4;
        } else {
            ea += reg(base);
        }
    } else {
        ea = reg(rm | (o.rex & 1 ? 8 : 0));
    }
    if (mod === 1) ea += signed8(b[p]);
    else if (mod === 2) ea += rel32(b, p);
    return num(readU64(ea));
}

// Where a call to `target` ends up after the incremental-linking and import thunks, and whether
// stopping there is safe: its module's symbols are loaded, or it is in no module.
function resolveCode(target) {
    let table = readModules();
    for (let hop = 0; hop < 6; hop++) {
        let m = moduleAt(table, target);
        if (!m) return { addr: target, safe: true };
        if (m.deferred) return { addr: target, safe: false, module: m.name };
        let b = safe(() => targetBytes(target, 8), null);
        if (!b) return { addr: target, safe: true };
        if (b[0] === 0xe9) target = target + 5 + rel32(b, 1);
        else if (b[0] === 0xeb) target = target + 2 + signed8(b[1]);
        else if (b[0] === 0xff && b[1] === 0x25) target = num(readU64(target + 6 + rel32(b, 2)));
        else if (b[0] === 0x48 && b[1] === 0xff && b[2] === 0x25) target = num(readU64(target + 7 + rel32(b, 3)));
        else return { addr: target, safe: true, module: m.name };
    }
    return { addr: target, safe: true };
}

// The instructions of the source line holding addr, from addr on: its calls, returns, and the
// addresses where execution leaves it (branches out of it, falling through to the next line).
// `unknown` when an indirect jump (a switch) or its size make that incomplete.
function scanLine(addr) {
    let first = instructionAt(addr);
    let out = { line: first ? first.line : undefined, calls: [], rets: [], exits: [], unknown: false };
    if (!first || first.line === undefined) {
        out.unknown = true;
        return out;
    }
    let seen = new Set();
    let exits = new Set();
    let work = [addr];
    let count = 0;
    while (work.length > 0 && !out.unknown) {
        let a = work.pop();
        if (seen.has(a)) continue;
        for (let ins of disassemblerOf().DisassembleInstructions(a)) {
            let x = instructionInfo(ins);
            if (seen.has(x.addr)) break;
            if (x.line !== out.line || x.fn !== first.fn) {
                exits.add(x.addr);
                break;
            }
            seen.add(x.addr);
            if (++count > MAX_LINE_INSTRUCTIONS) {
                out.unknown = true;
                break;
            }
            if (x.isRet) {
                out.rets.push(x.addr);
                break;
            }
            if (x.isCall) {
                let t = callTarget(x, undefined);
                out.calls.push({ addr: x.addr, len: x.len, target: t === undefined ? undefined : resolveCode(t) });
                continue;
            }
            if (x.isBranch) {
                let t = directTarget(x);
                if (t === undefined) {
                    out.unknown = true;
                    break;
                }
                work.push(t);
                if (!x.isConditional) break;
            }
        }
    }
    for (let e of exits) out.exits.push(e);
    return out;
}

// --------------------------------------------------------------------- ops

const ops = {
    ping: () => "pong",

    reset: () => {
        walkModules = undefined;
        walkedStacks.clear();
        frameNames.clear();
        // A frame's register view must not outlive the stop.
        contextFrame = "?";
        resetContext();
        handles.clear();
        rawMemberCache.clear();
        frameScopes.clear();
        currentFrameModule = undefined;
        return true;
    },

    pid: () => num(host.currentProcess.Id),

    // { localPath, fullPath, local, include, exclude, always, program }: include, exclude and
    // always are regular expression sources, matched case-insensitively against module names
    // without extension.
    configureSymbols: (req) => {
        let regexps = list => (list || []).map(s => new RegExp(s, "i"));
        autoLoad = { local: !!req.local, include: regexps(req.include), exclude: regexps(req.exclude), always: regexps(req.always), program: req.program };
        symbolPaths = { localPath: req.localPath || "", fullPath: req.fullPath || "" };
        networkDrives = new Set((req.networkDrives || []).map(d => String(d).toUpperCase()));
        setSymbolPath(symbolPaths.localPath);
        return true;
    },

    // { pattern }: one more module to always load (a regular expression source).
    addAlwaysLoad: (req) => {
        autoLoad.always.push(new RegExp(req.pattern, "i"));
        return true;
    },

    // { command }: a command that loads symbols on request, run with the symbol servers.
    // { module, command }: loads symbols on request, with the symbol servers: command (ld, .reload)
    // for module, or every deferred module when module is "*".
    explicitLoad: (req) => explicitLoad(req),

    // { tid, scan }: what a Step Into from the thread's current instruction must know (see "steps"):
    // the instruction (a call's resolved target) and with scan, the calls and exits of the current
    // line. Addresses are hex strings.
    stepPlan: (req) => {
        let th = findThread(req.tid);
        if (contextFrame !== null) resetContext();
        let regs = th.Registers.User;
        let ip = num(regs.rip);
        let ins = safe(() => instructionAt(ip), null);
        let hexCode = c => c ? { addr: hexOf(c.addr), safe: c.safe, module: c.module } : undefined;
        let out = { ip: hexOf(ip), sp: hexOf(num(regs.rsp)), line: ins ? ins.line : undefined, len: ins ? ins.len : 0, isCall: !!ins && ins.isCall };
        if (ins && ins.isCall) {
            let t = safe(() => callTarget(ins, regs), undefined);
            out.call = t === undefined ? { safe: false } : hexCode(resolveCode(t));
        }
        if (req.scan) {
            let s = scanLine(ip);
            out.scan = {
                line: s.line,
                unknown: s.unknown,
                calls: s.calls.map(c => ({ addr: hexOf(c.addr), target: hexCode(c.target) })),
                exits: s.exits.map(hexOf)
            };
        }
        return out;
    },

    // The modules whose symbols are deferred: lower case names without extension. Loads nothing.
    deferredModules: () => readModules().filter(m => m.deferred).map(m => m.name.toLowerCase()),

    // { addr }: the module holding addr, and whether its symbols are still deferred. Loads nothing.
    moduleAt: (req) => {
        let m = moduleAt(readModules(), num(int64(req.addr)));
        return m ? { name: m.name, deferred: m.deferred } : {};
    },

    // Loads the local PDBs of the modules already loaded (the ones no `ld` event will report).
    autoLoadExisting: () => {
        let loaded = [];
        if (!autoLoad.local && autoLoad.always.length === 0) return loaded;
        for (let m of host.currentProcess.Modules) {
            if (safe(() => String(m.SymbolType), "") !== "Deferred") continue;
            let image = safe(() => String(m.Name), "");
            let name = moduleBaseName(image);
            // cdb names the launched exe by its file name only.
            if (!/[\\/]/.test(image) && autoLoad.program && moduleBaseName(autoLoad.program).toLowerCase() === name.toLowerCase()) image = autoLoad.program;
            if (/[\\/]/.test(image) && loadAtModuleLoad(image, name, num(m.BaseAddress))) loaded.push(name);
        }
        return loaded;
    },

    // { bps: [{ id, command, module }] }: command is the bu command with MODULE_SLOT where the
    // module name goes; module, when set, is the only module it may bind in.
    bindBreakpoints: (req) => {
        let modules = pdbModules();
        let bound = [];
        for (let bp of req.bps) {
            let rec = { command: bp.command, module: bp.module, tried: new Set() };
            pendingBps.set(bp.id, rec);
            let b = bindIn(bp.id, rec, modules);
            if (b) bound.push(b);
        }
        return bound;
    },

    // Tries the pending breakpoints in the modules whose PDB got loaded since.
    retryBreakpoints: () => pendingBps.size === 0 ? [] : bindPending(pdbModules()),

    dropBreakpoints: (req) => {
        for (let id of req.ids) pendingBps.delete(id);
        return true;
    },

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
        let start = req.start || 0;
        let levels = req.levels || 1000;
        let frames = walkThread(findThread(req.tid), start + levels + 1);
        let out = [];
        for (let i = start; i < frames.length && out.length < levels; i++) out.push(frameInfo(frames[i], i));
        let w = walkedStacks.get(num(findThread(req.tid).Id));
        // An unfinished walk: there are more frames than these.
        return { frames: out, total: w && w.complete ? frames.length : frames.length + 1 };
    },

    where: (req) => {
        let th = host.currentThread;
        let depth = req.depth || 8;
        let frames = walkThread(th, depth);
        let out = [];
        for (let i = 0; i < frames.length && i < depth; i++) out.push(frameInfo(frames[i], i));
        return { tid: num(th.Id), frames: out };
    },

    // Puts back the threads' own registers as dbgeng's view: before the target runs.
    resetContext: () => {
        resetContext();
        return true;
    },

    allStacks: (req) => {
        let out = [];
        let max = req.maxFrames || 200;
        for (let t of host.currentProcess.Threads) {
            let frames = [];
            try {
                let walked = walkThread(t, max);
                for (let i = 0; i < walked.length && i < max; i++) frames.push(frameInfo(walked[i], i));
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
        frameContext(num(findThread(req.tid).Id), req.frame || 0);
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
        return withoutLoads(list);
    },

    // req.context is the DAP one. Only the Debug Console ("repl") falls back to dbgeng's search of
    // every module for a name the frame does not know. Nothing loads symbols: a module whose
    // symbols are deferred is reported (needSymbols) instead.
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
        return withoutLoads(run);
    },

    setValue: (req) => noLoads(() => {
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
    }),

    dataInfo: (req) => noLoads(() => {
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
    }),

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

    viewString: (req) => noLoads(() => {
        let v;
        if (req.ref !== undefined) {
            v = childOf(getHandle(req.ref), req.name).obj;
        } else {
            ensureContext(req.tid, req.frame);
            v = evaluateValue(req.expr, { lookup: "lax", tid: req.tid, frame: req.frame }).v;
        }
        return { text: stringOf(v) };
    }),

    format: (req) => {
        // Formats several expressions at once, used by logpoints.
        ensureContext(req.tid, req.frame);
        return noLoads(() => req.exprs.map(x => {
            try {
                let r = evaluateValue(x, { lookup: "strict", tid: req.tid, frame: req.frame });
                let str = specString(r.v, r.spec);
                return { ok: true, value: str !== undefined ? str : display(normalize(r.v), r.hint, r.hex, 0) };
            } catch (err) {
                return { ok: false, value: errMsg(err) };
            }
        }));
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
    return [new host.apiVersionSupport(1, 3), new host.functionAlias(vscwdbg, "vscwdbg"), new host.functionAlias(onModuleLoad, "vscwdbgld")];
}

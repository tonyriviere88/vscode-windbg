import { DebugProtocol } from '@vscode/debugprotocol';

export interface SymbolOptions {
    /** Local directory where downloaded PDBs are cached. */
    cachePath?: string;
    /** Flat directories searched for PDBs (no symbol-store layout). */
    searchPaths?: string[];
    /** Symbol servers (http/https URLs or UNC symbol stores). */
    servers?: string[];
    /** Adds https://msdl.microsoft.com/download/symbols when true. */
    useMicrosoftSymbolServer?: boolean;
    /** Appends _NT_SYMBOL_PATH from the environment. */
    inheritNtSymbolPath?: boolean;
    /** Prints symbol loading diagnostics (!sym noisy). */
    verbose?: boolean;
}

export type ConsoleKind = 'externalTerminal' | 'internalConsole';

export interface ExceptionOverride {
    /** 'cpp' for a C++ type name, 'win32' for an exception code. */
    category: 'cpp' | 'win32';
    /** Type name (C++) or hexadecimal exception code without 0x (Win32). */
    id: string;
    /** True to break when thrown, false never to break when thrown. */
    enabled: boolean;
}

export interface CommonArguments {
    debuggerPath?: string;
    symbolPath?: string;
    symbols?: SymbolOptions;
    sourcePaths?: string[];
    sourceServer?: boolean;
    sourceFileMap?: Record<string, string>;
    visualizerFile?: string | string[];
    natvis?: string[];
    justMyCode?: boolean;
    justMyCodeConfig?: string;
    showExternalCode?: boolean;
    initCommands?: string[];
    consoleMode?: 'commands' | 'expressions';
    /** Seconds after which an evaluation (watch, hover, variables, logpoint) is interrupted; 0: never. */
    evaluationTimeout?: number;
    trace?: boolean;
    hexadecimalDisplay?: boolean;
    workspaceFolder?: string;
    /** Filled in by the extension from the Exception Settings view. */
    exceptionOverrides?: ExceptionOverride[];
}

export interface LaunchArguments extends DebugProtocol.LaunchRequestArguments, CommonArguments {
    program?: string;
    args?: string[] | string;
    cwd?: string;
    env?: Record<string, string | null>;
    stopOnEntry?: boolean;
    console?: ConsoleKind;
    dumpFile?: string;
}

export interface AttachArguments extends DebugProtocol.AttachRequestArguments, CommonArguments {
    processId?: number | string;
    processName?: string;
    nonInvasive?: boolean;
}

export interface FrameInfo {
    i: number;
    text?: string;
    ip?: string;
    sp?: string;
    inl?: boolean;
    fn?: string;
    file?: string;
    line?: number;
    mod?: string;
}

export interface BridgeVar {
    name: string;
    value: string;
    type?: string;
    ref?: number;
    indexed?: number;
    evalName?: string;
    mem?: string;
}

/** A module whose deferred symbols a hover needed and did not load. */
export interface SymbolHint {
    module: string;
    /** Dynamic type of the value, when that is what needed the symbols. */
    type?: string;
}

/** What the script reports about symbols for a hover (evaluated without loading symbols). */
export interface NoLoadResult {
    needSymbols?: SymbolHint[];
    /** Modules whose symbols got loaded anyway, by a natvis expression naming another module. */
    loadedSymbols?: string[];
    /** Set instead of a value when the hover failed for want of symbols. */
    failed?: string;
}

export interface ThreadInfo {
    id: number;
    index: number;
    name: string;
}

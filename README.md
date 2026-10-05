# WinDbg Debugger for VS Code

Debug native Windows programs (C, C++, and anything else with PDBs) from VS Code with the
WinDbg engine (`dbgeng` through `cdb.exe`).

It adds the parts of the Visual Studio debugger that VS Code lacks: Just My Code with a rules
file, natvis, Parallel Stacks, a WinDbg-style command window, and per-type "break when thrown"
exception settings.

## Requirements

- Windows x64 or ARM64.
- `cdb.exe` from **Debugging Tools for Windows** (Windows SDK, optional feature "Debugging Tools
  for Windows"), or from the WinDbg app. The extension looks in
  `C:\Program Files (x86)\Windows Kits\10\Debuggers\<arch>`, then the WinDbg app, then `PATH`;
  set `windbg.debuggerPath` to override.
- Programs built with debug information (`/Zi` + `/DEBUG`).

## Quick start

1. Run **Debug: Add Configuration...** and choose one of the **WinDbg** snippets:

   | Snippet | Use |
   | --- | --- |
   | WinDbg: Launch | Start a program |
   | WinDbg: Launch with symbols and natvis | Start a program with symbol servers, a cache and natvis files |
   | WinDbg: Launch (output in Debug Console) | Program output goes to the Debug Console |
   | WinDbg: Attach to Process | Pick a running process |
   | WinDbg: Attach by Name | Attach to `app.exe` |
   | WinDbg: Open Crash Dump | Inspect a `.dmp` file |

2. Set `program` and press F5.

```jsonc
{
    "name": "WinDbg: Launch",
    "type": "windbg",
    "request": "launch",
    "program": "${workspaceFolder}/build/Debug/app.exe",
    "args": ["--verbose"],
    "cwd": "${workspaceFolder}",
    "console": "externalTerminal"
}
```

## Features

### Flow control

Continue, pause, step over, step into, step out, and **Run to Cursor**. **Jump to Cursor** (set next
statement) moves the instruction pointer. Stepping works by source line, or by instruction when
the Disassembly view has focus. `stopOnEntry` breaks at `main`, `wmain`, `WinMain` or `wWinMain`.

### Just My Code

With `justMyCode` on (the default):

- **Step into** skips external functions, including STL internals, CRT startup and thunks. It
  continues into the next user call on the same line.
- **Step over / step out** that would land in external code keep running until user code is
  reached.
- External frames collapse into **[External Code]** in the Call Stack. Toggle them with
  **Show External Code** / **Hide External Code** in the Call Stack context menu.

Code is external when its function, source file or module matches a rule in the configuration
file. Use **WinDbg: Open Just My Code Configuration** to create `.vscode/jmc.json` (the
path is set by `windbg.justMyCode.configFile` or `justMyCodeConfig`). The file reloads
automatically.

```jsonc
{
    "inheritDefaults": true,              // keep built-in rules: std, CRT, Windows SDK, system DLLs
    "external": {
        "symbols": ["boost", "fmt::*", "MyLib::Detail", "Qt*", "zlib!*"],
        "files":   ["${workspaceFolder}/third_party", "C:/Program Files*", "*_moc.cpp"],
        "modules": ["Qt6*", "libcurl"]
    },
    "user": {                              // wins over "external"
        "symbols": ["MyLib::Detail::callbacks"],
        "files": [],
        "modules": []
    }
}
```

- **symbols**: a namespace, class or function. `std` matches `std::...` and `std<...>`, and
  template arguments are optional (`lib::Vec::size` matches `lib::Vec<int>::size`).
  `module!pattern` also checks the module.
- **files**: absolute paths match as prefixes; relative paths match anywhere in the path.
- **modules**: module names without extension.
- `*` (any characters) and `?` (one character) work everywhere. Code without source information
  is always external.

### Variables, watch and strings

- **Locals** (parameters and locals) and **Registers** for every frame. Structures, classes,
  arrays and pointers expand recursively; base classes appear as `[Base]` nodes.
- Values are shown Visual Studio style: `{x=1 y=2}`, `0x000000c1b1cff640 {x=3 y=4}`,
  `L"wide"`, `Green (5)`.
- **Watch** and hover use the C++ expression evaluator of the debugger. Format specifiers:
  `,x` hex, `,d` decimal, `,!` raw view (no natvis), `ptr,10` (view a pointer as an array of 10
  elements), and strings: `,s` / `,sz` / `,s8` (narrow), `,su` (UTF-16), `,sb` / `,sub` (without
  quotes). A string specifier reads what any pointer or address points to: `(void*)p,su`.
- Registers: `rdi`, `$rdi` or `@rdi` (sub-registers too: `edi`, `dil`), so `(char*)rdi,sz` works.
  Visual Studio's pseudo-variables `$tid`, `$pid` and `$err` (last error) are available. A hover
  only takes the `$`/`@` forms. Values come from the stopped thread.
- An evaluation still running after `evaluationTimeout` seconds (default 10) is interrupted and
  shown as an error, so a slow natvis or symbol lookup never blocks the debugger.
- Names are looked up the way Visual Studio does, without leaving the frame's module: locals
  and parameters, members of `this` (so hovering `m_value` in a method works), the enclosing
  classes and namespaces, then the module's globals. `module!name` or Visual Studio's
  `{,,module.dll}name` reaches another module. A name found nowhere is reported as undefined at
  once; only the Debug Console falls back to cdb's search of every module, which can take minutes
  in a large process.
- **A hover never loads symbols.** It does not call functions or change values either. When the
  value's dynamic type, or a `module!name`, needs a module whose symbols are not loaded yet, the
  hover shows what it can and a notification offers **Load Symbols** for that module.
- **Set Value**, **Copy Value**, **Add to Watch**, **View Binary Data** (memory view) and
  **Break on Value Change** (data breakpoints) work in the Variables view.
- **View String** (Variables/Watch context menu) opens the full content of a `char*`,
  `wchar_t*`, `std::string`, `std::wstring` or char array in an editor. JSON, XML and HTML get
  syntax highlighting.

### Natvis

The engine's own visualizers (STL, ATL/MFC, WinRT...) are always active. More natvis files load
from:

- `visualizerFile` / `natvis` in the launch configuration,
- `windbg.natvis.files`,
- every `*.natvis` in the workspace folder (`windbg.natvis.loadWorkspaceFiles`, on by default).

Visualized objects keep a **[Raw View]** child.

### Threads, call stacks and Parallel Stacks

Every thread and its call stack appear in the Call Stack view. Selecting a frame switches the
context used by Locals, Watch and the Debug Console.

**WinDbg: Show Parallel Stacks** (debug toolbar or Call Stack context menu) opens the Visual
Studio-style graph:

- Threads that share a call path are merged into one box; boxes split where threads diverge.
- The current thread is highlighted.
- Clicking a frame opens its source and switches the evaluation context to it.
- Drag with the left button to pan. When the graph does not fit, an overview in the bottom-right
  corner shows the whole graph and the visible part as a rectangle; drag the rectangle, or click
  elsewhere in the overview, to move the view.

### Command window

**WinDbg: Show Command Window** (debug toolbar, Call Stack context menu or Command Palette)
opens a WinDbg-style command window beside the editor:

- The transcript holds the session's output, a banner for every stop (`Breakpoint hit`,
  `Exception thrown: ...`, followed by `module!function+0x1a [file @ line]`), and commands typed
  here or in the Debug Console with their output. It keeps filling while the window is closed.
- The prompt shows the selected thread as WinDbg does (`0:003>`), and `*BUSY*` while the target
  runs. Commands always run as WinDbg commands, in the frame selected in VS Code. Use `~3 k` or
  `~3s; k` for another thread.
- **Enter** on an empty line repeats the last command, as in WinDbg. **Up**/**Down** browse the
  history, which persists across sessions. **Ctrl+Break** or the **Break** button pauses the
  target. `.cls` or **Clear** empties the window.
- `g`, `p`, `t` and `gu` run, step and step out like the debug toolbar.
- Source locations (`[d:\src\a.cpp @ 57]`, `d:\src\a.cpp(57)`) open the file at that line.
  Clicking an address inserts it into the command line.
- The toolbar buttons run the commands of `windbg.commandWindow.quickCommands`. Find
  (**Ctrl+F**) and **Wrap** work on the transcript.

### Breakpoints

- **Source**, **function** (`app::compute`, `module!func`), **data** (break on value change)
  and **instruction** (Disassembly view) breakpoints.
- **Conditions**: any C++ expression, evaluated by the engine.
- **Hit counts**: `5` or `==5` (exactly), `>=5`, `>5`, `<5`, `<=5`, `%5` (every 5th hit).
- **Actions (logpoints)**: the message is printed and execution continues. `{expression}` is
  replaced by its value. The Visual Studio keywords `$FUNCTION`, `$CALLER`, `$CALLSTACK`,
  `$TID`, `$PID`, `$ADDRESS` and `$FILEPOS` work too.

### Exceptions

The **Breakpoints** view has three filters:

| Filter | Default | Condition |
| --- | --- | --- |
| C++ Exceptions | off | Type names to break on, e.g. `std::runtime_error, MyNs::*` |
| Access Violations | on | |
| Other Win32 Exceptions | off | Codes to break on, e.g. `c0000094, c00000fd` |

Unhandled (second-chance) exceptions always break.

When a thrown exception breaks:

- The exception widget shows its type and message (`what()` for `std::exception`).
- A notification offers **Don't Break on `<type>`**, the equivalent of unchecking Visual
  Studio's "Break when this exception type is thrown".

The **WinDbg Exceptions** view (Run and Debug side bar) lists these per-type choices as
checkboxes. Check to always break on that type, uncheck to never break; you can add C++ types
(wildcards allowed) or Win32 codes. The settings are saved per workspace and apply immediately
to running sessions.

### Symbols (PDB)

| Setting | Meaning |
| --- | --- |
| `windbg.symbols.cachePath` | Local cache for downloaded PDBs (default `%LOCALAPPDATA%\vscode-windbg\SymbolCache`) |
| `windbg.symbols.searchPaths` | Directories with PDB files (searched first, not copied to the cache) |
| `windbg.symbols.servers` | Symbol servers: `https://...` or `\\server\store`; each becomes `srv*<cache>*<server>` |
| `windbg.symbols.useMicrosoftSymbolServer` | Adds `https://msdl.microsoft.com/download/symbols` (default on) |
| `windbg.symbols.inheritNtSymbolPath` | Appends `_NT_SYMBOL_PATH` (default on) |
| `windbg.symbols.verbose` | Prints symbol-loading diagnostics |

The **WinDbg Modules** view (Run and Debug side bar) lists every loaded DLL and EXE, refreshed
at each stop. For each module:

- the icon and description show the symbol state: **PDB loaded** (✓), **not loaded yet**
  (cdb loads symbols on demand), or **no PDB (exports only)** (⚠);
- the tooltip shows the full path, address range, size, version, timestamp, PDB path, and
  whether Just My Code treats the module as user code.

Actions on a module: **Load Symbols**, **Symbol Load Information** (reloads the module with
symbol diagnostics on and shows every path tried, like Visual Studio), **Copy Path**, **Copy PDB
Path** and **Reveal in File Explorer**. The title bar has **Load All Symbols**, **Refresh**, and
sorting by name or load address. Type in the view to filter it.

The same keys are available per configuration under `"symbols": { ... }`. `symbolPath` takes a
raw dbgeng symbol path. `sourcePaths`, `sourceServer` and `sourceFileMap` control where sources
are found. **WinDbg: Reload Symbols** reloads them in a running session.

### Debug Console

By default the Debug Console takes WinDbg commands: `k`, `lm`, `!analyze -v`, `dt`, `!heap`...
`dx <expression>` gives an expandable value. Execution commands (`g`, `p`, `t`, `gu`, `q`)
behave like the toolbar buttons.

With `"windbg.console.mode": "expressions"`, input is evaluated as a C++ expression instead, and
`-exec <command>` runs a WinDbg command.

### Also

- Disassembly view, memory view (read/write), crash dumps (`dumpFile`), attach by id or name,
  non-invasive attach (`nonInvasive`).
- `initCommands`: debugger commands run before breakpoints are set.
- `windbg.hexadecimalDisplay` / **WinDbg: Toggle Hexadecimal Display**.
- `trace`: logs the whole cdb conversation to the Debug Console.

## Launch configuration reference

| Attribute | Request | Description |
| --- | --- | --- |
| `program` | launch | Executable to debug |
| `args` | launch | Arguments: an array, or a string passed verbatim |
| `cwd` | launch | Working directory (default: the program's directory) |
| `env` | launch | Variables to add (`null` removes one) |
| `stopOnEntry` | launch | Break at `main` / `WinMain` |
| `console` | launch | `externalTerminal` (own console window) or `internalConsole` (output in the Debug Console, no input) |
| `dumpFile` | launch | Open a crash dump instead of starting a program |
| `processId` / `processName` | attach | Process to attach to (`${command:windbg.pickProcess}` opens a picker) |
| `nonInvasive` | attach | Inspect without taking over the process |
| `debuggerPath` | both | `cdb.exe` to use |
| `symbols`, `symbolPath`, `sourcePaths`, `sourceServer`, `sourceFileMap` | both | Symbols and sources |
| `visualizerFile`, `natvis` | both | Natvis files |
| `justMyCode`, `justMyCodeConfig`, `showExternalCode` | both | Just My Code |
| `initCommands`, `consoleMode`, `hexadecimalDisplay`, `evaluationTimeout`, `trace` | both | Engine and console |

## Known limitations

- With Just My Code, **step into** does not stop in user callbacks that external code calls
  (for example a lambda passed to `std::sort`). Put a breakpoint in the callback instead.
- `internalConsole` output is buffered by the C runtime and does not accept input; use
  `externalTerminal` for interactive programs.
- Pause uses `breakin.exe` from the Debugging Tools (PowerShell `DebugBreakProcess` as a
  fallback), so the break-in thread briefly appears in the thread list.

## Development

```text
npm install
npm run compile
npm run test:unit            # rules, parsers, exception policy, parallel stacks model
npm run test:integration     # drives cdb.exe over DAP against test/sample (needs MSVC to build it)
npm run test:e2e             # runs the extension in VS Code (set VSCODE_EXECUTABLE to use a local VS Code)
```

**Run Extension** (F5) starts an Extension Development Host on `test/sample`, which has a ready
`launch.json`.

To release, bump `version` in `package.json` and push a matching tag (`git tag v0.2.0 && git push
origin v0.2.0`). The Release workflow runs the unit tests, packages the extension and publishes a
GitHub release with the `.vsix` attached. `npm run package` builds the same `.vsix` locally.

Layout:

| Path | Content |
| --- | --- |
| `src/adapter/` | Debug adapter: `session.ts` (DAP), `cdb.ts` (cdb process and command framing), `jmc.ts`, `exceptions.ts`, `modules.ts`, `parsers.ts`, `symbols.ts` |
| `dbgscript/vscode_windbg.js` | Data model script loaded into cdb: variables, natvis, stacks, memory, C++ exception decoding |
| `src/*.ts` | Extension: configuration provider, Exception Settings and Modules views, Parallel Stacks, command window, commands |
| `media/` | Parallel Stacks and command window webviews |
| `test/` | Unit, integration and end-to-end tests; `test/sample` is the C++ program they debug |

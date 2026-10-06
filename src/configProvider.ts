import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExceptionSettings } from './exceptionSettings';
import { pickProcess } from './processPicker';

function substitute(value: string, folder: vscode.WorkspaceFolder | undefined): string {
    return value
        .replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? '')
        .replace(/\$\{workspaceFolderBasename\}/g, folder?.name ?? '')
        .replace(/\$\{userHome\}/g, os.homedir())
        .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
}

function substituteAll(values: string[] | undefined, folder: vscode.WorkspaceFolder | undefined): string[] {
    return (values ?? []).map((v) => substitute(v, folder)).filter((v) => v.trim());
}

export const INITIAL_CONFIGURATIONS = [
    {
        name: 'WinDbg: Launch',
        type: 'windbg',
        request: 'launch',
        program: '${workspaceFolder}/build/Debug/app.exe',
        args: [],
        cwd: '${workspaceFolder}',
        stopOnEntry: false,
        console: 'externalTerminal',
    },
    {
        name: 'WinDbg: Attach to Process',
        type: 'windbg',
        request: 'attach',
        processId: '${command:windbg.pickProcess}',
    },
];

/** Fills launch configurations with defaults taken from the windbg.* settings. */
export class WinDbgConfigurationProvider implements vscode.DebugConfigurationProvider {
    constructor(private readonly exceptions: ExceptionSettings) {}

    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return INITIAL_CONFIGURATIONS;
    }

    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null | undefined> {
        if (!config.type && !config.request && !config.name) {
            // F5 without launch.json: open one so the user can set "program".
            void vscode.window.showInformationMessage('Create a launch.json with a "WinDbg: Launch" configuration and set "program" to your executable.');
            return null;
        }
        folder = folder ?? vscode.workspace.workspaceFolders?.[0];
        const settings = vscode.workspace.getConfiguration('windbg', folder?.uri);

        config.debuggerPath ??= substitute(settings.get<string>('debuggerPath', ''), folder) || undefined;
        config.workspaceFolder ??= folder?.uri.fsPath;

        const symbols = { ...(config.symbols ?? {}) };
        symbols.cachePath ??= substitute(settings.get<string>('symbols.cachePath', ''), folder) || undefined;
        symbols.searchPaths ??= substituteAll(settings.get<string[]>('symbols.searchPaths', []), folder);
        symbols.servers ??= substituteAll(settings.get<string[]>('symbols.servers', []), folder);
        symbols.useMicrosoftSymbolServer ??= settings.get<boolean>('symbols.useMicrosoftSymbolServer', true);
        symbols.inheritNtSymbolPath ??= settings.get<boolean>('symbols.inheritNtSymbolPath', true);
        symbols.verbose ??= settings.get<boolean>('symbols.verbose', false);
        symbols.autoLoadLocal ??= settings.get<boolean>('symbols.autoLoadLocal', true);
        symbols.autoLoadInclude ??= settings.get<string[]>('symbols.autoLoadInclude', []);
        symbols.autoLoadExclude ??= settings.get<string[]>('symbols.autoLoadExclude', []);
        symbols.alwaysLoad ??= settings.get<string[]>('symbols.alwaysLoad', []);
        config.symbols = symbols;

        const natvis = new Set<string>(substituteAll(settings.get<string[]>('natvis.files', []), folder));
        for (const n of [...(Array.isArray(config.natvis) ? config.natvis : []), ...(Array.isArray(config.visualizerFile) ? config.visualizerFile : config.visualizerFile ? [config.visualizerFile] : [])]) {
            natvis.add(n);
        }
        if (settings.get<boolean>('natvis.loadWorkspaceFiles', true) && folder) {
            // No result limit: a large repository has more natvis files than any fixed cap, and findFiles returns
            // them in no particular order, so a cap silently drops whole folders. Sorted for a stable load order.
            const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.natvis'), '**/node_modules/**');
            found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
            for (const f of found) {
                natvis.add(f.fsPath);
            }
        }
        config.natvis = [...natvis];
        delete config.visualizerFile;

        config.justMyCode ??= settings.get<boolean>('justMyCode.enabled', true);
        config.justMyCodeConfig ??= substitute(settings.get<string>('justMyCode.configFile', '${workspaceFolder}/.vscode/jmc.json'), folder);
        config.showExternalCode ??= settings.get<boolean>('justMyCode.showExternalCode', false);
        config.consoleMode ??= settings.get<string>('console.mode', 'commands');
        config.trace ??= settings.get<boolean>('trace', false);
        config.hexadecimalDisplay ??= settings.get<boolean>('hexadecimalDisplay', false);
        config.exceptionOverrides = this.exceptions.overrides;
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null | undefined> {
        const base = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const absolute = (p: string | undefined) => (p && base && !path.isAbsolute(p) ? path.join(base, p) : p);
        if (config.request === 'launch') {
            config.program = absolute(config.program);
            config.dumpFile = absolute(config.dumpFile);
            config.cwd = absolute(config.cwd);
        }
        config.justMyCodeConfig = absolute(config.justMyCodeConfig);
        config.natvis = (config.natvis as string[]).map((n) => absolute(n)!);
        if (config.request === 'attach' && !config.processId && !config.processName) {
            const pid = await pickProcess();
            if (!pid) {
                return undefined;
            }
            config.processId = pid;
        }
        return config;
    }
}

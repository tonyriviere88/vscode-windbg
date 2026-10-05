import * as vscode from 'vscode';
import { wildcardMatch } from './adapter/glob';
import { moduleBaseName } from './adapter/jmc';

/**
 * Adds a module to "windbg.symbols.alwaysLoad", like Visual Studio's "Always Load Automatically":
 * in the workspace settings when a folder is open, else in the user settings. Nothing is added when
 * an entry already covers the module.
 */
export async function addToAlwaysLoad(module: string): Promise<void> {
    const name = moduleBaseName(module);
    const config = vscode.workspace.getConfiguration('windbg');
    if (config.get<string[]>('symbols.alwaysLoad', []).some((p) => wildcardMatch(moduleBaseName(p.trim()), name, true))) {
        return;
    }
    const workspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const inspected = config.inspect<string[]>('symbols.alwaysLoad');
    const current = (workspace ? inspected?.workspaceValue : inspected?.globalValue) ?? [];
    await config.update('symbols.alwaysLoad', [...current, name], workspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}

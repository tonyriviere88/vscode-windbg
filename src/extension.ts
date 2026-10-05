import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JMC_TEMPLATE } from './adapter/jmc';
import { WinDbgSession } from './adapter/session';
import { CommandWindow } from './commandWindow';
import { INITIAL_CONFIGURATIONS, WinDbgConfigurationProvider } from './configProvider';
import { ExceptionSettings, activeWinDbgSessions, trackedSessions } from './exceptionSettings';
import { ModulesView } from './modulesView';
import { ParallelStacksPanel } from './parallelStacks';
import { pickProcess } from './processPicker';

interface VariableContext {
    sessionId?: string;
    container?: { variablesReference?: number; expression?: string };
    variable?: { name: string; value: string; evaluateName?: string; variablesReference?: number };
}

interface ExceptionEvent {
    category: 'cpp' | 'win32';
    id: string;
    label: string;
    message?: string;
    firstChance: boolean;
}

interface NeedSymbolsEvent {
    expression?: string;
    modules: Array<{ module: string; type?: string }>;
}

let showExternalCode = false;
/** Modules already offered for loading, per debug session: a hover asks once per module. */
const offeredSymbols = new Map<string, Set<string>>();

function guessLanguage(text: string): string {
    const t = text.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
            JSON.parse(t);
            return 'json';
        } catch {
            // not JSON
        }
    }
    if (t.startsWith('<') && t.endsWith('>')) {
        return /^<!doctype html|^<html/i.test(t) ? 'html' : 'xml';
    }
    return 'plaintext';
}

async function viewString(arg: VariableContext | undefined): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'windbg') {
        void vscode.window.showWarningMessage('No WinDbg debug session is active.');
        return;
    }
    let request: Record<string, unknown> | undefined;
    if (arg?.container?.variablesReference && arg.variable) {
        request = { variablesReference: arg.container.variablesReference, name: arg.variable.name };
    } else if (arg?.variable?.evaluateName) {
        request = { expression: arg.variable.evaluateName, frameId: vscode.debug.activeStackItem && 'frameId' in vscode.debug.activeStackItem ? vscode.debug.activeStackItem.frameId : undefined };
    } else {
        const expression = await vscode.window.showInputBox({ title: 'View string', prompt: 'Expression evaluating to a string' });
        if (!expression) {
            return;
        }
        const item = vscode.debug.activeStackItem;
        request = { expression, frameId: item && 'frameId' in item ? item.frameId : undefined };
    }
    try {
        const res = (await session.customRequest('viewString', request)) as { text: string };
        const doc = await vscode.workspace.openTextDocument({ content: res.text, language: guessLanguage(res.text) });
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (e) {
        void vscode.window.showErrorMessage(`Cannot view the string: ${(e as Error).message}`);
    }
}

async function openJmcConfig(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const configured = vscode.workspace.getConfiguration('windbg', folder?.uri).get<string>('justMyCode.configFile', '${workspaceFolder}/.vscode/jmc.json');
    if (!folder && configured.includes('${workspaceFolder}')) {
        void vscode.window.showWarningMessage('Open a folder to create a Just My Code configuration.');
        return;
    }
    const file = configured.replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? '');
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JMC_TEMPLATE, 'utf8');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function setShowExternalCode(show: boolean): Promise<void> {
    showExternalCode = show;
    await vscode.commands.executeCommand('setContext', 'windbg.showExternalCode', show);
    for (const s of activeWinDbgSessions()) {
        try {
            await s.customRequest('setShowExternalCode', { show });
        } catch {
            // session ending
        }
    }
    ParallelStacksPanel.refreshIfOpen();
}

async function onException(e: ExceptionEvent, exceptions: ExceptionSettings): Promise<void> {
    if (!e.firstChance || !vscode.workspace.getConfiguration('windbg').get<boolean>('exceptions.showNotification', true)) {
        return;
    }
    const dontBreak = e.category === 'cpp' ? `Don't Break on ${e.id}` : "Don't Break on This Exception";
    const choice = await vscode.window.showInformationMessage(`Exception thrown: ${e.label}${e.message ? ` - ${e.message}` : ''}`, dontBreak, 'Exception Settings');
    if (choice === dontBreak) {
        await exceptions.set({ category: e.category, id: e.id, enabled: false });
        void vscode.window.setStatusBarMessage(`WinDbg: no longer breaking when ${e.label} is thrown`, 4000);
    } else if (choice === 'Exception Settings') {
        await vscode.commands.executeCommand('windbg.exceptions.focus');
    }
}

/** A hover never loads symbols; this offers to load the ones it was missing. */
async function onNeedSymbols(session: vscode.DebugSession, e: NeedSymbolsEvent): Promise<void> {
    let offered = offeredSymbols.get(session.id);
    if (!offered) {
        offered = new Set();
        offeredSymbols.set(session.id, offered);
    }
    for (const m of e.modules) {
        const key = m.module.toLowerCase();
        if (offered.has(key)) {
            continue;
        }
        offered.add(key);
        const what = e.expression ? `"${e.expression}"` : 'this value';
        const message = m.type
            ? `${what} is a ${m.type}, described by the symbols of ${m.module}, which are not loaded. The hover shows its declared type instead.`
            : `The symbols of ${m.module} are not loaded, so the hover cannot show ${what}.`;
        const choice = await vscode.window.showInformationMessage(message, 'Load Symbols');
        if (choice) {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading symbols for ${m.module}` }, async () => {
                try {
                    await session.customRequest('loadSymbols', { module: m.module });
                    await vscode.commands.executeCommand('windbg.modules.refresh');
                } catch (err) {
                    void vscode.window.showErrorMessage(`Loading symbols failed: ${(err as Error).message}`);
                }
            });
        }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const exceptions = new ExceptionSettings(context);
    const modules = new ModulesView(context);
    const provider = new WinDbgConfigurationProvider(exceptions);
    CommandWindow.init(context);
    showExternalCode = vscode.workspace.getConfiguration('windbg').get<boolean>('justMyCode.showExternalCode', false);
    void vscode.commands.executeCommand('setContext', 'windbg.showExternalCode', showExternalCode);

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('windbg', provider),
        vscode.debug.registerDebugConfigurationProvider('windbg', { provideDebugConfigurations: () => INITIAL_CONFIGURATIONS }, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
        vscode.debug.registerDebugAdapterDescriptorFactory('windbg', {
            createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new WinDbgSession()),
        }),
        vscode.debug.registerDebugAdapterTrackerFactory('windbg', {
            createDebugAdapterTracker: (session) => ({
                onWillStartSession: () => {
                    trackedSessions.add(session);
                    CommandWindow.onSessionStart(session);
                },
                onWillStopSession: () => trackedSessions.delete(session),
                onWillReceiveMessage: (m: { type: string }) => CommandWindow.onWillReceiveMessage(session, m),
                onDidSendMessage: (m: { type: string; event?: string }) => {
                    CommandWindow.onDidSendMessage(session, m);
                    if (m.type !== 'event') {
                        return;
                    }
                    if (m.event === 'stopped') {
                        setTimeout(() => {
                            ParallelStacksPanel.refreshIfOpen();
                            modules.onStopped();
                        }, 50);
                    } else if (m.event === 'continued') {
                        ParallelStacksPanel.setRunning();
                    } else if (m.event === 'terminated') {
                        setTimeout(() => ParallelStacksPanel.refreshIfOpen(), 50);
                    }
                },
            }),
        }),
        vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
            if (e.session.type === 'windbg' && e.event === 'windbgException') {
                void onException(e.body as ExceptionEvent, exceptions);
            } else if (e.session.type === 'windbg' && e.event === 'windbgNeedSymbols') {
                void onNeedSymbols(e.session, e.body as NeedSymbolsEvent);
            }
        }),
        vscode.debug.onDidTerminateDebugSession((s) => offeredSymbols.delete(s.id)),
        vscode.debug.onDidStartDebugSession((s) => {
            if (s.type === 'windbg' && showExternalCode !== vscode.workspace.getConfiguration('windbg').get<boolean>('justMyCode.showExternalCode', false)) {
                void s.customRequest('setShowExternalCode', { show: showExternalCode }).then(undefined, () => undefined);
            }
        }),
        vscode.commands.registerCommand('windbg.pickProcess', () => pickProcess()),
        vscode.commands.registerCommand('windbg.parallelStacks', () => ParallelStacksPanel.show(context.extensionUri)),
        vscode.commands.registerCommand('windbg.commandWindow', () => CommandWindow.show()),
        vscode.commands.registerCommand('windbg.viewString', (arg?: VariableContext) => viewString(arg)),
        vscode.commands.registerCommand('windbg.showExternalCode', () => setShowExternalCode(true)),
        vscode.commands.registerCommand('windbg.hideExternalCode', () => setShowExternalCode(false)),
        vscode.commands.registerCommand('windbg.openJmcConfig', () => openJmcConfig()),
        vscode.commands.registerCommand('windbg.reloadSymbols', async () => {
            const s = activeWinDbgSessions()[0];
            if (!s) {
                void vscode.window.showWarningMessage('No WinDbg debug session is active.');
                return;
            }
            try {
                await s.customRequest('reloadSymbols');
                void vscode.window.setStatusBarMessage('WinDbg: symbols reloaded', 3000);
            } catch (e) {
                void vscode.window.showErrorMessage(`Reload failed: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('windbg.toggleHex', async () => {
            const config = vscode.workspace.getConfiguration('windbg');
            const hex = !config.get<boolean>('hexadecimalDisplay', false);
            await config.update('hexadecimalDisplay', hex, vscode.ConfigurationTarget.Global);
        }),
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('windbg.hexadecimalDisplay')) {
                const hex = vscode.workspace.getConfiguration('windbg').get<boolean>('hexadecimalDisplay', false);
                for (const s of activeWinDbgSessions()) {
                    await Promise.resolve(s.customRequest('setHexDisplay', { hex })).catch(() => undefined);
                }
            }
        }),
    );
}

export function deactivate(): void {
    // Sessions are disposed by VS Code.
}

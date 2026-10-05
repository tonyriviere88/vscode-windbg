import * as vscode from 'vscode';
import { KNOWN_WIN32_EXCEPTIONS, codeId } from './adapter/exceptions';
import { ExceptionOverride } from './adapter/types';

const STATE_KEY = 'windbg.exceptionOverrides';

type Category = 'cpp' | 'win32';

class CategoryItem extends vscode.TreeItem {
    constructor(public readonly category: Category) {
        super(category === 'cpp' ? 'C++ Exceptions' : 'Win32 Exceptions', vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = `category-${category}`;
        this.iconPath = new vscode.ThemeIcon(category === 'cpp' ? 'symbol-class' : 'symbol-event');
        this.tooltip =
            'Checked: break when thrown. Unchecked: never break when thrown.\n' +
            'Exceptions not listed here follow the exception filters of the Breakpoints view.\n' +
            'Unhandled (second chance) exceptions always break.';
    }
}

class OverrideItem extends vscode.TreeItem {
    constructor(public readonly override: ExceptionOverride) {
        super(override.category === 'win32' ? `0x${override.id}` : override.id, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'override';
        this.checkboxState = override.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        if (override.category === 'win32') {
            this.description = KNOWN_WIN32_EXCEPTIONS.find((e) => codeId(e.code) === override.id)?.name;
        }
        this.tooltip = `${this.label}${this.description ? ` (${this.description})` : ''}\n${override.enabled ? 'Breaks when thrown.' : 'Does not break when thrown.'}`;
    }
}

type Item = CategoryItem | OverrideItem;

/** "WinDbg Exceptions" view: per-exception "Break when thrown" checkboxes, like Visual Studio. */
export class ExceptionSettings implements vscode.TreeDataProvider<Item> {
    private readonly changed = new vscode.EventEmitter<Item | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly view: vscode.TreeView<Item>;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.view = vscode.window.createTreeView('windbg.exceptions', { treeDataProvider: this, manageCheckboxStateManually: true, showCollapseAll: false });
        context.subscriptions.push(
            this.view,
            this.view.onDidChangeCheckboxState((e) => {
                for (const [item, state] of e.items) {
                    if (item instanceof OverrideItem) {
                        this.set({ ...item.override, enabled: state === vscode.TreeItemCheckboxState.Checked });
                    }
                }
            }),
            vscode.commands.registerCommand('windbg.exceptions.addCpp', () => this.addCpp()),
            vscode.commands.registerCommand('windbg.exceptions.addWin32', () => this.addWin32()),
            vscode.commands.registerCommand('windbg.exceptions.remove', (item: OverrideItem) => item && this.remove(item.override)),
            vscode.commands.registerCommand('windbg.exceptions.reset', () => this.reset()),
            vscode.commands.registerCommand('windbg.exceptions.show', () => vscode.commands.executeCommand('windbg.exceptions.focus')),
        );
    }

    get overrides(): ExceptionOverride[] {
        return this.context.workspaceState.get<ExceptionOverride[]>(STATE_KEY, []);
    }

    getTreeItem(element: Item): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Item): Item[] {
        if (!element) {
            return [new CategoryItem('cpp'), new CategoryItem('win32')];
        }
        if (element instanceof CategoryItem) {
            return this.overrides
                .filter((o) => o.category === element.category)
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((o) => new OverrideItem(o));
        }
        return [];
    }

    /** Adds or updates an override and pushes the new list to running sessions. */
    async set(o: ExceptionOverride): Promise<void> {
        const list = this.overrides.filter((x) => !(x.category === o.category && x.id === o.id));
        list.push(o);
        await this.save(list);
    }

    private async remove(o: ExceptionOverride): Promise<void> {
        await this.save(this.overrides.filter((x) => !(x.category === o.category && x.id === o.id)));
    }

    private async reset(): Promise<void> {
        const answer = await vscode.window.showWarningMessage('Remove all exception overrides?', { modal: true }, 'Remove');
        if (answer === 'Remove') {
            await this.save([]);
        }
    }

    private async save(list: ExceptionOverride[]): Promise<void> {
        await this.context.workspaceState.update(STATE_KEY, list);
        this.changed.fire(undefined);
        await this.push();
    }

    async push(): Promise<void> {
        const sessions = activeWinDbgSessions();
        await Promise.all(
            sessions.map((s) =>
                Promise.resolve(s.customRequest('setExceptionOverrides', { overrides: this.overrides })).catch((e: Error) =>
                    vscode.window.showWarningMessage(`Could not update exception settings: ${e.message}`),
                ),
            ),
        );
    }

    private async addCpp(): Promise<void> {
        const id = await vscode.window.showInputBox({
            title: 'Add C++ exception type',
            prompt: 'Fully qualified type name; * and ? are wildcards',
            placeHolder: 'std::runtime_error',
            validateInput: (v) => (v.trim() ? undefined : 'Enter a type name'),
        });
        if (id?.trim()) {
            await this.set({ category: 'cpp', id: id.trim(), enabled: true });
        }
    }

    private async addWin32(): Promise<void> {
        const items: Array<vscode.QuickPickItem & { code?: string }> = KNOWN_WIN32_EXCEPTIONS.map((e) => ({
            label: `0x${codeId(e.code)}`,
            description: e.name,
            code: codeId(e.code),
        }));
        items.push({ label: 'Other code...', description: 'Enter an exception code' });
        const pick = await vscode.window.showQuickPick(items, { title: 'Add Win32 exception', matchOnDescription: true });
        if (!pick) {
            return;
        }
        let code = pick.code;
        if (!code) {
            const text = await vscode.window.showInputBox({
                title: 'Exception code',
                placeHolder: '0xC0000005',
                validateInput: (v) => (/^(0x)?[0-9a-f]{1,8}$/i.test(v.trim()) ? undefined : 'Enter a hexadecimal code'),
            });
            if (!text) {
                return;
            }
            code = codeId(parseInt(text.trim().replace(/^0x/i, ''), 16));
        }
        await this.set({ category: 'win32', id: code, enabled: true });
    }
}

export function activeWinDbgSessions(): vscode.DebugSession[] {
    const out: vscode.DebugSession[] = [];
    const s = vscode.debug.activeDebugSession;
    if (s?.type === 'windbg') {
        out.push(s);
    }
    for (const other of trackedSessions) {
        if (!out.includes(other)) {
            out.push(other);
        }
    }
    return out;
}

export const trackedSessions = new Set<vscode.DebugSession>();

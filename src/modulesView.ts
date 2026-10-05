import * as vscode from 'vscode';
import { WinDbgModule } from './adapter/modules';
import { addToAlwaysLoad } from './symbolSettings';

type SortOrder = 'name' | 'address';

class ModuleItem extends vscode.TreeItem {
    constructor(public readonly module: WinDbgModule) {
        super(module.name, vscode.TreeItemCollapsibleState.None);
        const m = module;
        this.id = m.baseAddress;
        this.contextValue = `module-${m.symbolKind}`;
        this.description = shortStatus(m);
        switch (m.symbolKind) {
            case 'pdb':
                this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case 'deferred':
                this.iconPath = new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('descriptionForeground'));
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        }
        // Paths go in code spans so their backslashes are shown as is.
        const code = (v: string | undefined) => (v ? '`' + v.replace(/`/g, "'") + '`' : undefined);
        const rows: Array<[string, string | undefined]> = [
            ['Path', code(m.path)],
            ['Address', code(m.addressRange)],
            ['Size', `${m.size.toLocaleString()} bytes`],
            ['Version', m.version],
            ['Timestamp', m.dateTimeStamp],
            ['Symbols', m.symbolStatus],
            ['PDB', code(m.symbolFilePath)],
            ['User code', m.isUserCode ? 'Yes' : 'No (Just My Code rules)'],
        ];
        const md = new vscode.MarkdownString(`**${m.name}**\n\n| | |\n|---|---|\n`);
        for (const [k, v] of rows) {
            if (v) {
                md.appendMarkdown(`| ${k} | ${v.replace(/\|/g, '\\|')} |\n`);
            }
        }
        this.tooltip = md;
    }
}

function shortStatus(m: WinDbgModule): string {
    const sym = m.symbolKind === 'pdb' ? 'PDB loaded' : m.symbolKind === 'deferred' ? 'not loaded yet' : m.symbolKind === 'export' ? 'no PDB (exports)' : 'no symbols';
    return `${sym}  ·  ${m.path}`;
}

function session(): vscode.DebugSession | undefined {
    const s = vscode.debug.activeDebugSession;
    return s?.type === 'windbg' ? s : undefined;
}

/** "WinDbg Modules": loaded DLLs/EXEs, their location and whether their PDB is loaded. */
export class ModulesView implements vscode.TreeDataProvider<ModuleItem> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly view: vscode.TreeView<ModuleItem>;
    private modules: WinDbgModule[] = [];
    private sort: SortOrder = 'name';
    private stale = true;

    constructor(context: vscode.ExtensionContext) {
        this.view = vscode.window.createTreeView('windbg.modules', { treeDataProvider: this, showCollapseAll: false });
        context.subscriptions.push(
            this.view,
            this.view.onDidChangeVisibility((e) => {
                if (e.visible && this.stale) {
                    void this.refresh();
                }
            }),
            vscode.debug.onDidChangeActiveDebugSession(() => this.invalidate()),
            vscode.debug.onDidTerminateDebugSession(() => this.invalidate()),
            vscode.commands.registerCommand('windbg.modules.refresh', () => this.refresh()),
            vscode.commands.registerCommand('windbg.modules.sortByName', () => this.setSort('name')),
            vscode.commands.registerCommand('windbg.modules.sortByAddress', () => this.setSort('address')),
            vscode.commands.registerCommand('windbg.modules.loadAllSymbols', () => this.loadSymbols(undefined)),
            vscode.commands.registerCommand('windbg.modules.loadSymbols', (item?: ModuleItem) => item && this.loadSymbols(item.module)),
            vscode.commands.registerCommand('windbg.modules.alwaysLoad', (item?: ModuleItem) => item && this.loadSymbols(item.module, true)),
            vscode.commands.registerCommand('windbg.modules.symbolInfo', (item?: ModuleItem) => item && this.symbolInfo(item.module)),
            vscode.commands.registerCommand('windbg.modules.copyPath', (item?: ModuleItem) => item && vscode.env.clipboard.writeText(item.module.path ?? item.module.name)),
            vscode.commands.registerCommand('windbg.modules.copyPdbPath', (item?: ModuleItem) => item?.module.symbolFilePath && vscode.env.clipboard.writeText(item.module.symbolFilePath)),
            vscode.commands.registerCommand('windbg.modules.reveal', (item?: ModuleItem) => item?.module.path && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.module.path))),
        );
        void vscode.commands.executeCommand('setContext', 'windbg.modules.sort', this.sort);
    }

    /** Called when the target stops: the module list may have changed. */
    onStopped(): void {
        if (this.view.visible) {
            void this.refresh();
        } else {
            this.stale = true;
        }
    }

    private invalidate(): void {
        if (!session()) {
            this.modules = [];
            this.view.description = undefined;
            this.changed.fire();
        }
        this.onStopped();
    }

    private setSort(order: SortOrder): void {
        this.sort = order;
        void vscode.commands.executeCommand('setContext', 'windbg.modules.sort', order);
        this.changed.fire();
    }

    async refresh(): Promise<void> {
        const s = session();
        this.stale = false;
        if (!s) {
            this.modules = [];
            this.view.description = undefined;
            this.changed.fire();
            return;
        }
        try {
            const res = (await s.customRequest('modules', {})) as { modules: WinDbgModule[] };
            this.update(res.modules);
        } catch (e) {
            this.view.message = `Modules unavailable: ${(e as Error).message}`;
        }
    }

    private update(modules: WinDbgModule[]): void {
        this.modules = modules;
        const withPdb = modules.filter((m) => m.symbolKind === 'pdb').length;
        this.view.description = `${modules.length} modules, ${withPdb} with PDB`;
        this.view.message = undefined;
        this.changed.fire();
    }

    private async loadSymbols(m: WinDbgModule | undefined, always = false): Promise<void> {
        const s = session();
        if (!s) {
            return;
        }
        if (always && m) {
            await addToAlwaysLoad(m.shortName);
        }
        await vscode.window.withProgress(
            { location: { viewId: 'windbg.modules' }, title: m ? `Loading symbols for ${m.name}` : 'Loading all symbols' },
            async () => {
                try {
                    const res = (await s.customRequest(always ? 'alwaysLoadSymbols' : 'loadSymbols', { module: m?.shortName })) as { modules: WinDbgModule[] };
                    this.update(res.modules);
                    const now = m ? res.modules.find((x) => x.baseAddress === m.baseAddress) : undefined;
                    if (now && now.symbolKind !== 'pdb') {
                        const pick = await vscode.window.showWarningMessage(`No PDB was found for ${m!.name}.`, 'Show Symbol Load Information');
                        if (pick) {
                            await this.symbolInfo(now);
                        }
                    }
                } catch (e) {
                    void vscode.window.showErrorMessage(`Loading symbols failed: ${(e as Error).message}`);
                }
            },
        );
    }

    private async symbolInfo(m: WinDbgModule): Promise<void> {
        const s = session();
        if (!s) {
            return;
        }
        try {
            const res = (await vscode.window.withProgress({ location: { viewId: 'windbg.modules' } }, () =>
                Promise.resolve(s.customRequest('symbolLoadInfo', { image: m.name })),
            )) as { output: string; modules: WinDbgModule[] };
            this.update(res.modules);
            const header = `Symbol load information for ${m.name}\n${m.path ?? ''}\n\n`;
            const doc = await vscode.workspace.openTextDocument({ content: header + res.output, language: 'log' });
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (e) {
            void vscode.window.showErrorMessage(`Symbol load information failed: ${(e as Error).message}`);
        }
    }

    getTreeItem(element: ModuleItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ModuleItem): ModuleItem[] {
        if (element) {
            return [];
        }
        const list = [...this.modules];
        if (this.sort === 'name') {
            list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        } else {
            list.sort((a, b) => (BigInt('0x' + a.baseAddress) < BigInt('0x' + b.baseAddress) ? -1 : 1));
        }
        return list.map((m) => new ModuleItem(m));
    }
}

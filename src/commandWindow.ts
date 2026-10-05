import * as vscode from 'vscode';
import { activeWinDbgSessions } from './exceptionSettings';

/** One piece of the transcript. Text keeps its own line breaks, so partial output lines join up. */
export interface TranscriptEntry {
    kind: 'command' | 'result' | 'error' | 'output' | 'stderr' | 'info' | 'event';
    text: string;
    /** For 'command': the prompt it was typed at. */
    prompt?: string;
}

interface CommandWindowState {
    state?: 'init' | 'stopped' | 'running' | 'terminated' | 'dump';
    prompt?: string;
    location?: string;
}

interface DapMessage {
    type: string;
    seq?: number;
    command?: string;
    event?: string;
    request_seq?: number;
    success?: boolean;
    message?: string;
    arguments?: { expression?: string; context?: string };
    body?: { category?: string; output?: string; reason?: string; description?: string; text?: string; result?: string };
}

const MAX_ENTRIES = 5000;
const HISTORY_KEY = 'windbg.commandWindow.history';
const WRAP_KEY = 'windbg.commandWindow.wrap';
const MAX_HISTORY = 500;
const BUSY = '*BUSY*';

const STOP_TEXT: Record<string, string> = {
    breakpoint: 'Breakpoint hit',
    'function breakpoint': 'Function breakpoint hit',
    'data breakpoint': 'Data breakpoint hit',
    'instruction breakpoint': 'Instruction breakpoint hit',
    pause: 'Break: the target was paused',
    entry: 'Stopped on entry',
};

const frameHighlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
});

/**
 * WinDbg's command window: the session transcript and a prompt for WinDbg commands.
 *
 * The transcript is fed from the debug adapter tracker even while the window is closed, so
 * opening it shows what happened so far. Commands run in the frame selected in VS Code, like
 * in the Debug Console; `~3 k` or `~3s; k` targets another thread.
 */
export class CommandWindow {
    private static instance: CommandWindow | undefined;
    private static context: vscode.ExtensionContext;
    private static transcript: TranscriptEntry[] = [];
    private static prompt = '';
    private static busy = false;
    /** Debug Console evaluations in flight, keyed by session id and request seq. */
    private static replRequests = new Map<string, string>();

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    /** Commands sent from this window whose reply has not arrived yet. */
    private running = 0;

    static init(context: vscode.ExtensionContext): void {
        CommandWindow.context = context;
        context.subscriptions.push(
            vscode.debug.onDidChangeActiveStackItem(() => void CommandWindow.refreshPrompt()),
            vscode.debug.onDidChangeActiveDebugSession(() => void CommandWindow.refreshPrompt()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('windbg.commandWindow.quickCommands')) {
                    CommandWindow.instance?.post({ type: 'quick', quick: CommandWindow.quickCommands() });
                }
            }),
        );
    }

    static show(): void {
        if (CommandWindow.instance) {
            CommandWindow.instance.panel.reveal(undefined, false);
            CommandWindow.instance.post({ type: 'focus' });
            return;
        }
        CommandWindow.instance = new CommandWindow();
    }

    // ------------------------------------------------- transcript feed

    static onSessionStart(session: vscode.DebugSession): void {
        CommandWindow.append({ kind: 'info', text: `\n--- ${session.name} ---\n` });
        CommandWindow.setPrompt('', true);
    }

    /** Requests from VS Code to the adapter: remembers Debug Console commands to echo them. */
    static onWillReceiveMessage(session: vscode.DebugSession, m: DapMessage): void {
        if (m.type === 'request' && m.command === 'evaluate' && m.arguments?.context === 'repl' && m.seq !== undefined) {
            CommandWindow.replRequests.set(`${session.id}:${m.seq}`, m.arguments.expression ?? '');
        }
    }

    /** Messages from the adapter to VS Code. */
    static onDidSendMessage(session: vscode.DebugSession, m: DapMessage): void {
        if (m.type === 'response' && m.command === 'evaluate' && m.request_seq !== undefined) {
            const key = `${session.id}:${m.request_seq}`;
            const expression = CommandWindow.replRequests.get(key);
            if (expression !== undefined) {
                CommandWindow.replRequests.delete(key);
                CommandWindow.append({ kind: 'command', prompt: CommandWindow.prompt || '>', text: expression });
                CommandWindow.append(m.success ? { kind: 'result', text: m.body?.result ?? '' } : { kind: 'error', text: m.message ?? 'Failed.' });
            }
            return;
        }
        if (m.type !== 'event') {
            return;
        }
        switch (m.event) {
            case 'output': {
                const category = m.body?.category ?? 'console';
                if (category !== 'telemetry' && m.body?.output) {
                    CommandWindow.append({ kind: category === 'stderr' ? 'stderr' : category === 'stdout' ? 'output' : 'info', text: m.body.output });
                }
                break;
            }
            case 'stopped':
                void CommandWindow.onStopped(session, m.body ?? {});
                break;
            case 'continued':
                CommandWindow.setPrompt(BUSY, true);
                break;
            case 'terminated':
                CommandWindow.append({ kind: 'info', text: 'Debug session ended.\n' });
                CommandWindow.setPrompt('', false);
                break;
        }
    }

    private static async onStopped(session: vscode.DebugSession, body: NonNullable<DapMessage['body']>): Promise<void> {
        let state: CommandWindowState = {};
        try {
            state = (await session.customRequest('commandWindowState', {})) as CommandWindowState;
        } catch {
            // session ending
        }
        const what = body.reason === 'exception' ? body.text ?? body.description : body.description ?? STOP_TEXT[body.reason ?? ''];
        const lines = [what, state.location].filter((l): l is string => !!l);
        if (lines.length > 0) {
            CommandWindow.append({ kind: 'event', text: lines.join('\n') + '\n' });
        }
        // Then onDidChangeActiveStackItem follows the frame VS Code selects.
        CommandWindow.setPrompt(state.prompt ?? CommandWindow.prompt, false);
    }

    private static append(...entries: TranscriptEntry[]): void {
        const t = CommandWindow.transcript;
        t.push(...entries);
        if (t.length > MAX_ENTRIES) {
            t.splice(0, t.length - MAX_ENTRIES);
        }
        CommandWindow.instance?.post({ type: 'append', entries });
    }

    private static setPrompt(prompt: string, busy: boolean): void {
        CommandWindow.prompt = prompt;
        CommandWindow.busy = busy;
        CommandWindow.instance?.postPrompt();
    }

    private static session(): vscode.DebugSession | undefined {
        return activeWinDbgSessions()[0];
    }

    private static frameId(session: vscode.DebugSession): number | undefined {
        const item = vscode.debug.activeStackItem;
        return item && item.session.id === session.id && 'frameId' in item ? item.frameId : undefined;
    }

    private static async refreshPrompt(): Promise<void> {
        const session = CommandWindow.session();
        if (!session) {
            CommandWindow.setPrompt('', false);
            return;
        }
        try {
            const s = (await session.customRequest('commandWindowState', { frameId: CommandWindow.frameId(session) })) as CommandWindowState;
            if (s.state === 'running') {
                CommandWindow.setPrompt(BUSY, true);
            } else if (s.state === 'stopped' || s.state === 'dump') {
                CommandWindow.setPrompt(s.prompt ?? '>', false);
            }
        } catch {
            // session ending
        }
    }

    private static quickCommands(): string[] {
        return vscode.workspace.getConfiguration('windbg').get<string[]>('commandWindow.quickCommands', []);
    }

    private static history(): string[] {
        return CommandWindow.context.globalState.get<string[]>(HISTORY_KEY, []);
    }

    // ------------------------------------------------------- the panel

    private constructor() {
        const extensionUri = CommandWindow.context.extensionUri;
        this.panel = vscode.window.createWebviewPanel(
            'windbg.commandWindow',
            'WinDbg Command',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            },
        );
        this.panel.webview.html = this.html(extensionUri);
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.disposables);
    }

    private dispose(): void {
        CommandWindow.instance = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    private post(message: Record<string, unknown>): void {
        void this.panel.webview.postMessage(message);
    }

    private postPrompt(): void {
        const busy = CommandWindow.busy || this.running > 0;
        this.post({ type: 'prompt', prompt: this.running > 0 ? BUSY : CommandWindow.prompt, busy, session: !!CommandWindow.session() });
    }

    private async onMessage(m: { type: string; command?: string; file?: string; line?: number; wrap?: boolean }): Promise<void> {
        switch (m.type) {
            case 'ready':
                this.post({
                    type: 'reset',
                    entries: CommandWindow.transcript,
                    history: CommandWindow.history(),
                    quick: CommandWindow.quickCommands(),
                    wrap: CommandWindow.context.globalState.get<boolean>(WRAP_KEY, true),
                });
                this.postPrompt();
                await CommandWindow.refreshPrompt();
                break;
            case 'run':
                await this.run(m.command ?? '');
                break;
            case 'clear':
                CommandWindow.transcript = [];
                this.post({ type: 'clear' });
                break;
            case 'pause': {
                const session = CommandWindow.session();
                if (session) {
                    await Promise.resolve(session.customRequest('pause', { threadId: 0 })).catch(() => undefined);
                }
                break;
            }
            case 'wrap':
                await CommandWindow.context.globalState.update(WRAP_KEY, !!m.wrap);
                break;
            case 'editQuickCommands':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'windbg.commandWindow.quickCommands');
                break;
            case 'open':
                if (m.file && m.line) {
                    await this.open(m.file, m.line);
                }
                break;
        }
    }

    private async run(command: string): Promise<void> {
        const text = command.trim();
        if (!text) {
            return;
        }
        await this.remember(text);
        CommandWindow.append({ kind: 'command', prompt: CommandWindow.prompt || '>', text });
        if (/^\.cls$/i.test(text)) {
            // cdb's .cls cannot clear this window; do it here, as WinDbg does.
            CommandWindow.transcript = [];
            this.post({ type: 'clear' });
            return;
        }
        const session = CommandWindow.session();
        if (!session) {
            CommandWindow.append({ kind: 'error', text: 'No WinDbg debug session is active.' });
            return;
        }
        this.running++;
        this.postPrompt();
        try {
            const res = (await session.customRequest('runCommand', { command: text, frameId: CommandWindow.frameId(session) })) as { output: string };
            if (res.output) {
                CommandWindow.append({ kind: 'result', text: res.output });
            }
        } catch (e) {
            CommandWindow.append({ kind: 'error', text: (e as Error).message });
        } finally {
            this.running--;
            this.postPrompt();
        }
    }

    private async remember(command: string): Promise<void> {
        const history = CommandWindow.history().filter((h) => h !== command);
        history.push(command);
        await CommandWindow.context.globalState.update(HISTORY_KEY, history.slice(-MAX_HISTORY));
    }

    private async open(file: string, line: number): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const range = new vscode.Range(line - 1, 0, line - 1, 0);
            const editor = await vscode.window.showTextDocument(doc, { selection: range, viewColumn: vscode.ViewColumn.One, preserveFocus: false });
            editor.setDecorations(frameHighlight, [range]);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (e) {
            void vscode.window.showWarningMessage(`Cannot open ${file}: ${(e as Error).message}`);
        }
    }

    private html(extensionUri: vscode.Uri): string {
        const webview = this.panel.webview;
        const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'commandWindow.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'commandWindow.css'));
        const nonce = Math.random().toString(36).slice(2);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>WinDbg Command</title>
</head>
<body>
<div class="toolbar">
  <button id="break" title="Break into the running target (Ctrl+Break)">Break</button>
  <button id="clear" title="Clear the window (.cls)">Clear</button>
  <span class="separator"></span>
  <span id="quick"></span>
  <button id="editQuick" class="icon" title="Edit the quick commands">&#x2026;</button>
  <span class="spacer"></span>
  <label title="Wrap long lines"><input type="checkbox" id="wrap"> Wrap</label>
</div>
<div id="output" tabindex="0" aria-live="polite"></div>
<div class="inputRow">
  <span id="prompt"></span>
  <input id="input" type="text" spellcheck="false" autocomplete="off" placeholder="WinDbg command (k, lm, dv /t, !analyze -v ...). Enter repeats the last command." aria-label="WinDbg command">
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

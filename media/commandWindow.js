// @ts-check
(function () {
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const output = /** @type {HTMLElement} */ (document.getElementById('output'));
    const input = /** @type {HTMLInputElement} */ (document.getElementById('input'));
    const prompt = /** @type {HTMLElement} */ (document.getElementById('prompt'));
    const quick = /** @type {HTMLElement} */ (document.getElementById('quick'));
    const wrap = /** @type {HTMLInputElement} */ (document.getElementById('wrap'));
    const breakButton = /** @type {HTMLButtonElement} */ (document.getElementById('break'));

    const MAX_ENTRIES = 5000;
    /**
     * Source locations as cdb prints them ("[d:\src\a.cpp @ 57]", "d:\src\a.cpp(57)") open the file;
     * addresses ("00007ff6`eeacd268", "0x7ff6eeacd268") go into the command line.
     */
    const LINK = /\[([A-Za-z]:\\[^\]\r\n@]*?) @ (\d+)\]|([A-Za-z]:\\[^\s()"<>|*?[\]]+?\.[A-Za-z0-9]+)\((\d+)\)|\b((?:0x)?[0-9a-f]{8}`[0-9a-f]{8})\b|\b(0x[0-9a-f]{4,16})\b/gi;

    /** @type {string[]} */
    let history = [];
    /** Position in `history` while browsing it; history.length means the draft. */
    let historyIndex = 0;
    let draft = '';
    /** WinDbg repeats the previous command when Enter is pressed on an empty line. */
    let lastCommand = '';
    let busy = false;

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) {
            e.className = cls;
        }
        if (text !== undefined) {
            e.textContent = text;
        }
        return e;
    }

    function appendLinked(parent, text) {
        let last = 0;
        LINK.lastIndex = 0;
        let m;
        while ((m = LINK.exec(text))) {
            if (m.index > last) {
                parent.append(text.slice(last, m.index));
            }
            const file = m[1] ?? m[3];
            if (file) {
                const a = el('a', 'source', m[0]);
                a.dataset.file = file;
                a.dataset.line = m[2] ?? m[4];
                a.title = 'Open in the editor';
                parent.append(a);
            } else {
                const a = el('span', 'address', m[0]);
                a.title = 'Insert into the command';
                parent.append(a);
            }
            last = m.index + m[0].length;
        }
        if (last < text.length) {
            parent.append(text.slice(last));
        }
    }

    function render(entry) {
        const span = el('span', `entry ${entry.kind}`);
        if (entry.kind === 'command') {
            span.append(el('span', 'echoPrompt', `${entry.prompt} `), el('span', 'echoCommand', entry.text), '\n');
            return span;
        }
        let text = entry.text;
        if ((entry.kind === 'result' || entry.kind === 'error' || entry.kind === 'event') && !text.endsWith('\n')) {
            text += '\n';
        }
        appendLinked(span, text);
        return span;
    }

    function atBottom() {
        return output.scrollHeight - output.scrollTop - output.clientHeight < 24;
    }

    function append(entries, forceScroll) {
        const stick = forceScroll || atBottom();
        const fragment = document.createDocumentFragment();
        for (const e of entries) {
            fragment.append(render(e));
        }
        output.append(fragment);
        while (output.childElementCount > MAX_ENTRIES && output.firstElementChild) {
            output.firstElementChild.remove();
        }
        if (stick) {
            output.scrollTop = output.scrollHeight;
        }
    }

    function setQuick(commands) {
        quick.textContent = '';
        for (const c of commands ?? []) {
            const b = el('button', 'quickCommand', c);
            b.title = `Run "${c}"`;
            b.addEventListener('click', () => run(c));
            quick.append(b);
        }
    }

    function setWrap(on) {
        wrap.checked = on;
        output.classList.toggle('nowrap', !on);
    }

    function run(command) {
        lastCommand = command;
        history = history.filter((h) => h !== command);
        history.push(command);
        historyIndex = history.length;
        draft = '';
        vscode.postMessage({ type: 'run', command });
        output.scrollTop = output.scrollHeight;
    }

    function insertAtCaret(text) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const before = input.value.slice(0, start);
        const pad = before && !/\s$/.test(before) ? ' ' : '';
        input.value = before + pad + text + input.value.slice(end);
        const caret = start + pad.length + text.length;
        input.focus();
        input.setSelectionRange(caret, caret);
    }

    window.addEventListener('message', (event) => {
        const m = event.data;
        switch (m.type) {
            case 'reset':
                output.textContent = '';
                history = m.history ?? [];
                historyIndex = history.length;
                setQuick(m.quick);
                setWrap(m.wrap !== false);
                append(m.entries ?? [], true);
                input.focus();
                break;
            case 'append':
                append(m.entries, false);
                break;
            case 'clear':
                output.textContent = '';
                break;
            case 'prompt':
                busy = !!m.busy;
                prompt.textContent = m.prompt || (m.session ? '>' : 'No session');
                prompt.classList.toggle('busy', busy);
                prompt.classList.toggle('none', !m.session);
                breakButton.disabled = !m.session;
                break;
            case 'quick':
                setQuick(m.quick);
                break;
            case 'focus':
                input.focus();
                break;
        }
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const command = input.value.trim();
            input.value = '';
            if (command) {
                run(command);
            } else if (lastCommand) {
                run(lastCommand);
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex > 0) {
                if (historyIndex === history.length) {
                    draft = input.value;
                }
                historyIndex--;
                input.value = history[historyIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex < history.length) {
                historyIndex++;
                input.value = historyIndex === history.length ? draft : history[historyIndex];
            }
        } else if (e.key === 'Escape') {
            input.value = '';
            historyIndex = history.length;
        } else if (e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault();
            output.scrollBy(0, (e.key === 'PageUp' ? -1 : 1) * output.clientHeight * 0.9);
        }
    });

    window.addEventListener('keydown', (e) => {
        // Ctrl+Break reports "Cancel" in Chromium.
        if ((e.key === 'Cancel' || (e.key === 'Pause' && e.ctrlKey)) && busy) {
            e.preventDefault();
            vscode.postMessage({ type: 'pause' });
        }
    });

    // Typing while the output has the focus goes to the command line; copying still works.
    output.addEventListener('keydown', (e) => {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            input.focus();
        }
    });

    output.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target.classList.contains('source')) {
            e.preventDefault();
            vscode.postMessage({ type: 'open', file: target.dataset.file, line: Number(target.dataset.line) });
        } else if (target.classList.contains('address')) {
            insertAtCaret(target.textContent ?? '');
        } else if (!window.getSelection()?.toString()) {
            input.focus();
        }
    });

    breakButton.addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
    document.getElementById('clear')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'clear' });
        input.focus();
    });
    document.getElementById('editQuick')?.addEventListener('click', () => vscode.postMessage({ type: 'editQuickCommands' }));
    wrap.addEventListener('change', () => {
        setWrap(wrap.checked);
        vscode.postMessage({ type: 'wrap', wrap: wrap.checked });
    });

    vscode.postMessage({ type: 'ready' });
})();

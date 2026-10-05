// @ts-check
(function () {
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const canvas = /** @type {HTMLElement} */ (document.getElementById('canvas'));
    const status = /** @type {HTMLElement} */ (document.getElementById('status'));
    const showExternal = /** @type {HTMLInputElement} */ (document.getElementById('showExternal'));
    const refresh = /** @type {HTMLButtonElement} */ (document.getElementById('refresh'));
    const viewport = /** @type {HTMLElement} */ (document.getElementById('viewport'));
    const minimap = /** @type {HTMLElement} */ (document.getElementById('minimap'));
    const minimapGraph = /** @type {HTMLCanvasElement} */ (document.getElementById('minimapGraph'));
    const minimapView = /** @type {HTMLElement} */ (document.getElementById('minimapView'));

    const BOX_W = 300;
    const HEADER_H = 26;
    const FRAME_H = 20;
    const H_GAP = 28;
    const V_GAP = 44;
    const MARGIN = 16;
    const MINIMAP_W = 220;
    const MINIMAP_H = 160;
    const DRAG_THRESHOLD = 4;

    /** Geometry of the rendered graph, used by the minimap. */
    let layout = null;
    let minimapScale = 1;

    showExternal.addEventListener('change', () => vscode.postMessage({ type: 'showExternal', show: showExternal.checked }));
    refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    window.addEventListener('message', (event) => {
        const m = event.data;
        if (m.type === 'graph') {
            showExternal.checked = !!m.showExternal;
            render(m.roots, m.current, m.names);
        } else if (m.type === 'empty') {
            canvas.innerHTML = '';
            canvas.style.width = canvas.style.height = '';
            layout = null;
            updateMinimap();
            status.textContent = m.text;
        } else if (m.type === 'running') {
            status.textContent = 'Running... the view updates when the target stops.';
            canvas.classList.add('stale');
        }
    });

    function measure(node) {
        node.h = HEADER_H + node.frames.length * FRAME_H + 6;
        let childrenWidth = 0;
        for (const c of node.children) {
            measure(c);
            childrenWidth += c.sw;
        }
        if (node.children.length > 1) {
            childrenWidth += H_GAP * (node.children.length - 1);
        }
        node.sw = Math.max(BOX_W, childrenWidth);
    }

    // y grows downwards: callers at the bottom, callees above them.
    function place(node, left, bottom, out) {
        node.x = left + (node.sw - BOX_W) / 2;
        node.y = bottom - node.h;
        out.push(node);
        let childrenWidth = node.children.reduce((s, c) => s + c.sw, 0) + H_GAP * Math.max(0, node.children.length - 1);
        let cursor = left + (node.sw - childrenWidth) / 2;
        for (const c of node.children) {
            place(c, cursor, node.y - V_GAP, out);
            c.parent = node;
            cursor += c.sw + H_GAP;
        }
    }

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

    function render(roots, current, names) {
        canvas.innerHTML = '';
        canvas.classList.remove('stale');
        if (!roots || roots.length === 0) {
            layout = null;
            updateMinimap();
            status.textContent = 'No threads.';
            return;
        }
        const all = [];
        let left = MARGIN;
        for (const r of roots) {
            measure(r);
            place(r, left, 0, all);
            left += r.sw + H_GAP * 2;
        }
        const minY = Math.min(...all.map((n) => n.y));
        const offset = MARGIN - minY;
        for (const n of all) {
            n.y += offset;
        }
        const width = left - H_GAP * 2 + MARGIN;
        const height = Math.max(...all.map((n) => n.y + n.h)) + MARGIN;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.classList.add('links');
        const defs = document.createElementNS(svgNs, 'defs');
        defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="arrowhead"/></marker>';
        svg.appendChild(defs);
        for (const n of all) {
            if (!n.parent) {
                continue;
            }
            const line = document.createElementNS(svgNs, 'path');
            const x1 = n.parent.x + BOX_W / 2;
            const y1 = n.parent.y;
            const x2 = n.x + BOX_W / 2;
            const y2 = n.y + n.h;
            const mid = (y1 + y2) / 2;
            line.setAttribute('d', `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2 + 2}`);
            line.setAttribute('marker-end', 'url(#arrow)');
            svg.appendChild(line);
        }
        canvas.appendChild(svg);

        let threadCount = 0;
        for (const n of all) {
            if (!n.parent) {
                threadCount += n.threads.length;
            }
            const box = el('div', 'box');
            box.style.left = n.x + 'px';
            box.style.top = n.y + 'px';
            box.style.width = BOX_W + 'px';
            const hasCurrent = n.threads.includes(current);
            if (hasCurrent) {
                box.classList.add('current');
            }
            const header = el('div', 'header', n.threads.length === 1 ? names[n.threads[0]] || '1 Thread' : `${n.threads.length} Threads`);
            header.title = n.threads.map((t) => names[t] || String(t)).join('\n');
            box.appendChild(header);
            // Innermost frame at the top of the box.
            const frames = [...n.frames].reverse();
            frames.forEach((f, i) => {
                const row = el('div', 'frame' + (f.external ? ' external' : ''));
                const isTop = i === 0 && n.children.length === 0;
                if (hasCurrent && isTop) {
                    row.appendChild(el('span', 'marker', '➤'));
                }
                row.appendChild(el('span', 'label', f.label));
                row.title = f.label + (f.file ? `\n${f.file}(${f.line})` : '');
                row.addEventListener('click', () => {
                    const tid = n.threads.includes(current) ? current : n.threads[0];
                    const frameIndex = f.frames[tid];
                    vscode.postMessage({ type: 'select', threadId: tid, frameIndex, file: f.file, line: f.line });
                    for (const r of canvas.querySelectorAll('.frame.selected')) {
                        r.classList.remove('selected');
                    }
                    row.classList.add('selected');
                });
                box.appendChild(row);
            });
            canvas.appendChild(box);
        }
        status.textContent = `${threadCount} threads`;
        layout = { width, height, nodes: all, current };
        viewport.scrollTop = viewport.scrollHeight;
        updateMinimap();
    }

    // Pan the graph by dragging it with the left button. A drag that moves past the threshold
    // swallows the click that follows, so it does not select the frame it started on.
    let pan = null;
    viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) {
            return;
        }
        // Leave presses on the scrollbars to the browser.
        if (e.target === viewport && (e.offsetX >= viewport.clientWidth || e.offsetY >= viewport.clientHeight)) {
            return;
        }
        pan = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!pan) {
            return;
        }
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
            return;
        }
        pan.moved = true;
        viewport.classList.add('panning');
        viewport.scrollLeft = pan.left - dx;
        viewport.scrollTop = pan.top - dy;
    });
    window.addEventListener('mouseup', (e) => {
        if (!pan || e.button !== 0) {
            return;
        }
        if (pan.moved) {
            const swallow = (c) => c.stopPropagation();
            window.addEventListener('click', swallow, true);
            // The click, if any, is dispatched right after mouseup; none follows when the button
            // is released over another element, so drop the listener before the next one.
            setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        }
        viewport.classList.remove('panning');
        pan = null;
    });

    viewport.addEventListener('scroll', updateMinimapView);
    new ResizeObserver(updateMinimap).observe(viewport);

    function cssColor(name) {
        return getComputedStyle(minimap).getPropertyValue(name).trim();
    }

    /** Redraws the whole-graph overview, or hides it when the graph fits in the viewport. */
    function updateMinimap() {
        if (!layout || (layout.width <= viewport.clientWidth && layout.height <= viewport.clientHeight)) {
            minimap.hidden = true;
            return;
        }
        minimap.hidden = false;
        // Keep the overview clear of the viewport's scrollbars.
        minimap.style.right = 12 + viewport.offsetWidth - viewport.clientWidth + 'px';
        minimap.style.bottom = 12 + viewport.offsetHeight - viewport.clientHeight + 'px';

        const scale = Math.min(MINIMAP_W / layout.width, MINIMAP_H / layout.height);
        minimapScale = scale;
        const w = Math.max(1, Math.round(layout.width * scale));
        const h = Math.max(1, Math.round(layout.height * scale));
        const dpr = window.devicePixelRatio || 1;
        minimapGraph.style.width = w + 'px';
        minimapGraph.style.height = h + 'px';
        minimapGraph.width = Math.round(w * dpr);
        minimapGraph.height = Math.round(h * dpr);

        const ctx = /** @type {CanvasRenderingContext2D} */ (minimapGraph.getContext('2d'));
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
        ctx.clearRect(0, 0, layout.width, layout.height);
        ctx.strokeStyle = cssColor('--ps-link');
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        for (const n of layout.nodes) {
            if (n.parent) {
                ctx.moveTo(n.parent.x + BOX_W / 2, n.parent.y);
                ctx.lineTo(n.x + BOX_W / 2, n.y + n.h);
            }
        }
        ctx.stroke();
        const boxColor = cssColor('--ps-box');
        const currentColor = cssColor('--ps-current');
        for (const n of layout.nodes) {
            ctx.fillStyle = n.threads.includes(layout.current) ? currentColor : boxColor;
            ctx.fillRect(n.x, n.y, BOX_W, n.h);
        }
        updateMinimapView();
    }

    /** Moves the rectangle that shows which part of the graph the viewport displays. */
    function updateMinimapView() {
        if (!layout || minimap.hidden) {
            return;
        }
        const s = minimapScale;
        const left = Math.min(viewport.scrollLeft, layout.width);
        const top = Math.min(viewport.scrollTop, layout.height);
        const width = Math.min(viewport.clientWidth, layout.width - left);
        const height = Math.min(viewport.clientHeight, layout.height - top);
        // The canvas sits inside the minimap's padding.
        minimapView.style.left = minimapGraph.offsetLeft + left * s + 'px';
        minimapView.style.top = minimapGraph.offsetTop + top * s + 'px';
        minimapView.style.width = Math.max(4, width * s) + 'px';
        minimapView.style.height = Math.max(4, height * s) + 'px';
    }

    // Dragging the rectangle pans the viewport; pressing elsewhere in the overview centres the
    // viewport on that point and keeps dragging from there.
    let minimapDrag = null;
    minimap.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !layout) {
            return;
        }
        const s = minimapScale;
        const rect = minimapGraph.getBoundingClientRect();
        const px = (e.clientX - rect.left) / s;
        const py = (e.clientY - rect.top) / s;
        if (e.target !== minimapView) {
            viewport.scrollLeft = px - viewport.clientWidth / 2;
            viewport.scrollTop = py - viewport.clientHeight / 2;
        }
        minimapDrag = { dx: px - viewport.scrollLeft, dy: py - viewport.scrollTop };
        minimap.classList.add('dragging');
        minimap.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    minimap.addEventListener('pointermove', (e) => {
        if (!minimapDrag) {
            return;
        }
        const s = minimapScale;
        const rect = minimapGraph.getBoundingClientRect();
        viewport.scrollLeft = (e.clientX - rect.left) / s - minimapDrag.dx;
        viewport.scrollTop = (e.clientY - rect.top) / s - minimapDrag.dy;
    });
    const endMinimapDrag = () => {
        minimapDrag = null;
        minimap.classList.remove('dragging');
    };
    minimap.addEventListener('pointerup', endMinimapDrag);
    minimap.addEventListener('pointercancel', endMinimapDrag);

    vscode.postMessage({ type: 'ready' });
})();

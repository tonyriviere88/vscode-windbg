/** Builds the Visual Studio-style "Parallel Stacks" graph from per-thread call stacks. */

export interface PsFrame {
    index: number;
    module?: string;
    fn?: string;
    file?: string;
    line?: number;
    user: boolean;
}

export interface PsThread {
    id: number;
    index: number;
    name: string;
    /** frames[0] is the innermost frame. */
    frames: PsFrame[];
}

export interface PsNodeFrame {
    label: string;
    external: boolean;
    /** Thread id -> frame index in that thread, for navigation. */
    frames: Record<number, number>;
    file?: string;
    line?: number;
}

export interface PsNode {
    id: number;
    threads: number[];
    /** Outermost (caller) first. */
    frames: PsNodeFrame[];
    children: PsNode[];
}

const EXTERNAL = '[External Code]';

function frameLabel(f: PsFrame): string {
    const fn = f.fn ?? '<unknown>';
    return f.module ? `${f.module}!${fn}` : fn;
}

interface TrieNode {
    key: string;
    external: boolean;
    threads: Set<number>;
    frames: Record<number, number>;
    file?: string;
    line?: number;
    children: Map<string, TrieNode>;
}

/** Returns root nodes (thread entry points); children are callees. */
export function buildParallelStacks(threads: PsThread[], showExternal: boolean): PsNode[] {
    const root: TrieNode = { key: '', external: false, threads: new Set(), frames: {}, children: new Map() };
    for (const t of threads) {
        // Outermost first; runs of external frames collapse into one when hidden.
        const chain: Array<{ key: string; external: boolean; frame: PsFrame }> = [];
        for (const f of [...t.frames].reverse()) {
            if (!showExternal && !f.user) {
                const last = chain[chain.length - 1];
                if (last && last.external) {
                    last.frame = f;
                    continue;
                }
                chain.push({ key: EXTERNAL, external: true, frame: f });
            } else {
                chain.push({ key: frameLabel(f), external: !f.user, frame: f });
            }
        }
        let node = root;
        node.threads.add(t.id);
        for (const c of chain) {
            let child = node.children.get(c.key);
            if (!child) {
                child = { key: c.key, external: c.external, threads: new Set(), frames: {}, file: c.frame.file, line: c.frame.line, children: new Map() };
                node.children.set(c.key, child);
            }
            child.threads.add(t.id);
            child.frames[t.id] = c.frame.index;
            node = child;
        }
    }

    let nextId = 1;
    const convert = (n: TrieNode): PsNode => {
        const out: PsNode = { id: nextId++, threads: [...n.threads], frames: [], children: [] };
        let cur: TrieNode | undefined = n;
        // Merge the chain while every frame is shared by exactly the same threads.
        while (cur) {
            out.frames.push({ label: cur.key, external: cur.external, frames: cur.frames, file: cur.file, line: cur.line });
            if (cur.children.size === 1) {
                const only: TrieNode = [...cur.children.values()][0];
                if (only.threads.size === cur.threads.size) {
                    cur = only;
                    continue;
                }
            }
            out.children = [...cur.children.values()].map(convert);
            cur = undefined;
        }
        return out;
    };
    return [...root.children.values()].map(convert);
}

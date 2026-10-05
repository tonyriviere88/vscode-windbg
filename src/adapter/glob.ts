/**
 * Wildcard matching shared by Just My Code rules and exception filters.
 * '*' matches any run of characters (including separators), '?' one character.
 */
export function wildcardToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
    let src = '';
    for (const ch of pattern) {
        if (ch === '*') {
            if (!src.endsWith('.*')) {
                src += '.*';
            }
        } else if (ch === '?') {
            src += '.';
        } else {
            src += ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
        }
    }
    return new RegExp('^' + src + '$', caseInsensitive ? 'i' : '');
}

export function hasWildcard(pattern: string): boolean {
    return pattern.includes('*') || pattern.includes('?');
}

export function wildcardMatch(pattern: string, text: string, caseInsensitive = false): boolean {
    return wildcardToRegExp(pattern, caseInsensitive).test(text);
}

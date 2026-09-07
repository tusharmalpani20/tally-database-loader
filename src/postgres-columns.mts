export function quoteIdentifier(name: string): string {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
    return `"${name}"`;
}

export function csvColumns(header: string): string[] {
    const columns = header.replace(/^\uFEFF/, '').trim().split(',').map(value => {
        const name = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
        quoteIdentifier(name);
        return name;
    });
    if (!columns.length || new Set(columns).size !== columns.length) throw new Error('Invalid CSV header');
    return columns;
}

export function copyStatement(table: string, columns: string[]): string {
    if (!columns.length || new Set(columns).size !== columns.length) throw new Error('Invalid COPY columns');
    return `copy ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) from stdin csv header;`;
}

const luaparse: any = require('luaparse');

interface LuaNode {
    type: string;
    range?: [number, number];
    loc?: { start: { line: number }; end: { line: number } };
    [key: string]: any;
}

export interface LuaModulePatch {
    code: string;
}

interface ChangedLines {
    oldLines: Set<number>;
    newLines: Set<number>;
}

interface MapOperation {
    code: string;
    references: LuaNode[];
}

export function generateLuaModulePatch(
    moduleName: string,
    oldSource: string,
    newSource: string,
    diff: string
): LuaModulePatch {
    const oldAst = parseLua(oldSource, moduleName, '旧版本');
    const newAst = parseLua(newSource, moduleName, '新版本');
    const changedLines = parseChangedLines(diff);
    if (changedLines.oldLines.size === 0 && changedLines.newLines.size === 0) {
        throw new Error(`${moduleName} 的 SVN diff 中没有 Lua 代码变更`);
    }

    const oldBody = oldAst.body as LuaNode[];
    const newBody = newAst.body as LuaNode[];
    const moduleRoot = inferModuleRoot(moduleName, newBody, oldBody);
    const oldPublic = indexPublicStatements(oldBody, moduleRoot);
    const newPublic = indexPublicStatements(newBody, moduleRoot);
    const selectedPublic = new Map<string, LuaNode>();
    const removedTargets = new Set<string>();
    const changedFunctionTargets = new Set<string>();

    for (const node of newBody.filter(item => overlaps(item, changedLines.newLines))) {
        const key = publicStatementKey(node, moduleRoot);
        if (key && !isMapStatement(node)) {
            selectedPublic.set(key, node);
            if (isFunctionStatement(node)) { changedFunctionTargets.add(key); }
        }
    }

    for (const node of oldBody.filter(item => overlaps(item, changedLines.oldLines))) {
        const key = publicStatementKey(node, moduleRoot);
        if (!key || isMapStatement(node)) { continue; }
        const replacement = newPublic.get(key);
        if (replacement) {
            selectedPublic.set(key, replacement);
            if (isFunctionStatement(replacement)) { changedFunctionTargets.add(key); }
        } else {
            removedTargets.add(key);
            if (isFunctionStatement(node)) { changedFunctionTargets.add(key); }
        }
    }

    const localDeclarations = indexLocalDeclarations(newBody);
    const changedLocals = new Set<string>();
    for (const node of newBody.filter(item => overlaps(item, changedLines.newLines))) {
        for (const name of declaredLocalNames(node)) { changedLocals.add(name); }
    }
    for (const node of oldBody.filter(item => overlaps(item, changedLines.oldLines))) {
        for (const name of declaredLocalNames(node)) {
            if (localDeclarations.has(name)) { changedLocals.add(name); }
        }
    }

    for (const localName of changedLocals) {
        if (localName === moduleRoot) {
            throw new Error(`${moduleName} 修改了模块初始化声明，无法安全生成运行时 patch`);
        }
        for (const [key, node] of newPublic) {
            if (isFunctionStatement(node) && collectReferencedIdentifiers(node).has(localName)) {
                selectedPublic.set(key, node);
                changedFunctionTargets.add(key);
            }
        }
    }

    const mapOperations = buildMapOperations(
        oldBody,
        newBody,
        oldSource,
        newSource,
        changedLines,
        moduleRoot,
        changedFunctionTargets
    );

    const unsupported = findUnsupportedChangedStatements(newBody, changedLines.newLines, moduleRoot);
    if (unsupported.length > 0) {
        throw new Error(`${moduleName} 包含无法安全热更的顶层 ${unsupported[0].type} 修改`);
    }

    if (selectedPublic.size === 0 && removedTargets.size === 0 && mapOperations.length === 0) {
        throw new Error(`${moduleName} 的修改未关联到可替换的模块函数或字段`);
    }

    const dependencyNames = new Set<string>();
    const referenceNodes = [...selectedPublic.values(), ...mapOperations.flatMap(item => item.references)];
    for (const node of referenceNodes) {
        for (const name of collectReferencedIdentifiers(node)) {
            if (name !== moduleRoot && localDeclarations.has(name)) { dependencyNames.add(name); }
        }
    }
    for (const name of changedLocals) {
        if ([...selectedPublic.values()].some(node => collectReferencedIdentifiers(node).has(name))) {
            dependencyNames.add(name);
        }
    }

    const dependencyStatements = new Set<LuaNode>();
    const pending = [...dependencyNames];
    while (pending.length > 0) {
        const name = pending.pop()!;
        const declaration = localDeclarations.get(name);
        if (!declaration || dependencyStatements.has(declaration)) { continue; }
        dependencyStatements.add(declaration);
        for (const dependency of collectReferencedIdentifiers(declaration)) {
            if (dependency !== moduleRoot && localDeclarations.has(dependency)) {
                pending.push(dependency);
            }
        }
    }

    const moduleVariable = moduleRoot.match(/^[A-Za-z_][A-Za-z0-9_]*$/)
        ? moduleRoot
        : moduleName.split('.').pop()!.replace(/\W/g, '_');
    const sections = [`local ${moduleVariable} = require(${quoteLua(moduleName)})`];
    const dependencies = [...dependencyStatements]
        .filter(node => !declaredLocalNames(node).includes(moduleRoot))
        .sort(bySourceOrder)
        .map(node => sourceOf(newSource, node));
    if (dependencies.length > 0) { sections.push(...dependencies); }

    const publicStatements = [...selectedPublic.values()]
        .sort(bySourceOrder)
        .map(node => sourceOf(newSource, node));
    sections.push(...publicStatements);
    for (const target of removedTargets) { sections.push(`${target} = nil`); }
    sections.push(...mapOperations.map(item => item.code));

    return { code: sections.join('\n\n') };
}

function parseLua(source: string, moduleName: string, label: string): LuaNode {
    try {
        return luaparse.parse(source, {
            comments: true,
            locations: true,
            ranges: true,
            luaVersion: '5.1'
        });
    } catch (error: any) {
        throw new Error(`${moduleName} ${label} Lua 解析失败: ${error.message}`);
    }
}

function parseChangedLines(diff: string): ChangedLines {
    const oldLines = new Set<number>();
    const newLines = new Set<number>();
    const lines = diff.split(/\r?\n/);
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const line of lines) {
        const header = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
        if (header) {
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            inHunk = true;
            continue;
        }
        if (!inHunk || line.startsWith('\\ No newline')) { continue; }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            newLines.add(newLine++);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            oldLines.add(oldLine++);
        } else {
            oldLine++;
            newLine++;
        }
    }
    return { oldLines, newLines };
}

function inferModuleRoot(moduleName: string, newBody: LuaNode[], oldBody: LuaNode[]): string {
    for (const body of [newBody, oldBody]) {
        for (let index = body.length - 1; index >= 0; index--) {
            const node = body[index];
            if (node.type === 'ReturnStatement' && node.arguments?.length === 1 && node.arguments[0].type === 'Identifier') {
                return node.arguments[0].name;
            }
        }
    }

    const counts = new Map<string, number>();
    for (const node of [...newBody, ...oldBody]) {
        const target = statementTarget(node);
        const root = target && rootIdentifier(target);
        if (root) { counts.set(root, (counts.get(root) || 0) + 1); }
    }
    let best = '';
    let bestCount = 0;
    for (const [name, count] of counts) {
        if (count > bestCount) {
            best = name;
            bestCount = count;
        }
    }
    return best || moduleName.split('.').pop()!.replace(/\W/g, '_');
}

function indexPublicStatements(body: LuaNode[], moduleRoot: string): Map<string, LuaNode> {
    const result = new Map<string, LuaNode>();
    for (const node of body) {
        const key = publicStatementKey(node, moduleRoot);
        if (key) { result.set(key, node); }
    }
    return result;
}

function publicStatementKey(node: LuaNode, moduleRoot: string): string | undefined {
    const target = statementTarget(node);
    if (!target || rootIdentifier(target) !== moduleRoot) { return undefined; }
    return canonicalMember(target);
}

function statementTarget(node: LuaNode): LuaNode | undefined {
    if (node.type === 'FunctionDeclaration' && !node.isLocal) { return node.identifier; }
    if (node.type === 'AssignmentStatement' && node.variables?.length === 1) { return node.variables[0]; }
    return undefined;
}

function isFunctionStatement(node: LuaNode): boolean {
    return node.type === 'FunctionDeclaration' ||
        (node.type === 'AssignmentStatement' && node.init?.length === 1 && node.init[0].type === 'FunctionDeclaration');
}

function isMapStatement(node: LuaNode): boolean {
    const target = statementTarget(node);
    if (!target || node.type !== 'AssignmentStatement' || node.init?.length !== 1) { return false; }
    return isMapName(memberLeaf(target)) && node.init[0].type === 'TableConstructorExpression';
}

function indexLocalDeclarations(body: LuaNode[]): Map<string, LuaNode> {
    const result = new Map<string, LuaNode>();
    for (const node of body) {
        for (const name of declaredLocalNames(node)) {
            if (!result.has(name)) { result.set(name, node); }
        }
    }
    return result;
}

function declaredLocalNames(node: LuaNode): string[] {
    if (node.type === 'LocalStatement') {
        return (node.variables || []).filter((item: LuaNode) => item.type === 'Identifier').map((item: LuaNode) => item.name);
    }
    if (node.type === 'FunctionDeclaration' && node.isLocal && node.identifier?.type === 'Identifier') {
        return [node.identifier.name];
    }
    return [];
}

function buildMapOperations(
    oldBody: LuaNode[],
    newBody: LuaNode[],
    oldSource: string,
    newSource: string,
    changedLines: ChangedLines,
    moduleRoot: string,
    changedFunctionTargets: Set<string>
): MapOperation[] {
    const operations = new Map<string, MapOperation>();
    const oldMaps = indexMaps(oldBody, moduleRoot);
    const newMaps = indexMaps(newBody, moduleRoot);

    for (const [target, map] of newMaps) {
        const oldMap = oldMaps.get(target);
        const fields = map.table.fields as LuaNode[];
        fields.forEach((field, index) => {
            const valueTarget = canonicalMember(field.value);
            const changedField = overlaps(field, changedLines.newLines);
            if (changedField || (valueTarget && changedFunctionTargets.has(valueTarget))) {
                const operation = mapFieldOperation(target, field, index, newSource);
                operations.set(operation.code, operation);
            }
        });

        if (oldMap) {
            const newKeys = new Set(fields.map((field, index) => mapFieldKey(field, index, newSource)));
            (oldMap.table.fields as LuaNode[]).forEach((field, index) => {
                if (!overlaps(field, changedLines.oldLines)) { return; }
                const key = mapFieldKey(field, index, oldSource);
                if (!newKeys.has(key)) {
                    const code = `${target}${key} = nil`;
                    operations.set(code, { code, references: field.key ? [field.key] : [] });
                }
            });
        }
    }
    return [...operations.values()];
}

function indexMaps(body: LuaNode[], moduleRoot: string): Map<string, { table: LuaNode }> {
    const result = new Map<string, { table: LuaNode }>();
    for (const node of body) {
        if (!isMapStatement(node)) { continue; }
        const targetNode = statementTarget(node)!;
        if (rootIdentifier(targetNode) !== moduleRoot) { continue; }
        result.set(canonicalMember(targetNode)!, { table: node.init[0] });
    }
    return result;
}

function mapFieldOperation(target: string, field: LuaNode, index: number, source: string): MapOperation {
    const key = mapFieldKey(field, index, source);
    const value = sourceOf(source, field.value);
    return {
        code: `${target}${key} = ${value}`,
        references: field.key ? [field.key, field.value] : [field.value]
    };
}

function mapFieldKey(field: LuaNode, index: number, source: string): string {
    if (field.type === 'TableKey') { return `[${sourceOf(source, field.key)}]`; }
    if (field.type === 'TableKeyString') { return `[${quoteLua(field.key.name)}]`; }
    return `[${index + 1}]`;
}

function findUnsupportedChangedStatements(body: LuaNode[], lines: Set<number>, moduleRoot: string): LuaNode[] {
    return body.filter(node => {
        if (!overlaps(node, lines)) { return false; }
        if (declaredLocalNames(node).length > 0) { return false; }
        if (publicStatementKey(node, moduleRoot)) { return false; }
        return node.type !== 'ReturnStatement';
    });
}

function collectReferencedIdentifiers(node: LuaNode): Set<string> {
    const result = new Set<string>();
    walk(node, undefined, '', (current, parent, key) => {
        if (current.type !== 'Identifier') { return; }
        if (parent?.type === 'MemberExpression' && key === 'identifier') { return; }
        if (parent?.type === 'TableKeyString' && key === 'key') { return; }
        if (parent?.type === 'FunctionDeclaration' && (key === 'identifier' || key === 'parameters')) { return; }
        if (parent?.type === 'LocalStatement' && key === 'variables') { return; }
        result.add(current.name);
    });
    return result;
}

function walk(
    node: any,
    parent: LuaNode | undefined,
    key: string,
    visit: (node: LuaNode, parent: LuaNode | undefined, key: string) => void
): void {
    if (!node || typeof node !== 'object') { return; }
    if (typeof node.type === 'string') { visit(node, parent, key); }
    for (const [childKey, value] of Object.entries(node)) {
        if (childKey === 'loc' || childKey === 'range' || childKey === 'comments') { continue; }
        if (Array.isArray(value)) {
            for (const child of value) { walk(child, node, childKey, visit); }
        } else if (value && typeof value === 'object') {
            walk(value, node, childKey, visit);
        }
    }
}

function canonicalMember(node: LuaNode | undefined): string | undefined {
    if (!node) { return undefined; }
    if (node.type === 'Identifier') { return node.name; }
    if (node.type === 'MemberExpression') {
        const base = canonicalMember(node.base);
        return base ? `${base}.${node.identifier.name}` : undefined;
    }
    if (node.type === 'IndexExpression' && node.index?.type === 'StringLiteral') {
        const base = canonicalMember(node.base);
        return base ? `${base}.${node.index.value}` : undefined;
    }
    return undefined;
}

function rootIdentifier(node: LuaNode): string | undefined {
    let current = node;
    while (current?.type === 'MemberExpression' || current?.type === 'IndexExpression') {
        current = current.base;
    }
    return current?.type === 'Identifier' ? current.name : undefined;
}

function memberLeaf(node: LuaNode): string {
    if (node.type === 'MemberExpression') { return node.identifier.name; }
    if (node.type === 'IndexExpression' && node.index?.type === 'StringLiteral') { return node.index.value; }
    return node.type === 'Identifier' ? node.name : '';
}

function isMapName(name: string): boolean {
    return name === 'EMAP' || name === 'TMAP' || name === 'AMAP';
}

function overlaps(node: LuaNode, lines: Set<number>): boolean {
    if (!node.loc || lines.size === 0) { return false; }
    for (const line of lines) {
        if (line >= node.loc.start.line && line <= node.loc.end.line) { return true; }
    }
    return false;
}

function sourceOf(source: string, node: LuaNode): string {
    if (!node.range) { throw new Error('Lua AST 缺少源码范围信息'); }
    return source.slice(node.range[0], node.range[1]).trim();
}

function quoteLua(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function bySourceOrder(a: LuaNode, b: LuaNode): number {
    return (a.range?.[0] || 0) - (b.range?.[0] || 0);
}

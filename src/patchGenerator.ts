import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import { SvnService } from './svnService';
import { AiService } from './aiService';
import { getOutputChannel } from './outputChannel';

export interface PatchLogEntry {
    revision: string;
    author: string;
    message: string;
    paths?: Array<{ action: string; path: string }>;
}

interface PatchPathMappings {
    clientConfig?: string;
    battleConfig?: string;
    clientSource?: string;
    battleSource?: string;
}

export class PatchGenerator {
    private readonly output = getOutputChannel();

    constructor(
        private readonly svnService: SvnService,
        private readonly aiService: AiService
    ) { }

    public async generateRevision(revision: number, targetPath: string): Promise<void> {
        const cwd = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
        const xml = await this.svnService.executeSvnCommand(
            `log -r ${revision} --verbose --xml "${targetPath}"`, cwd, false
        );
        const entryMatch = /<logentry\s+revision="([^"]+)">([\s\S]*?)<\/logentry>/.exec(xml);
        if (!entryMatch) {
            throw new Error(`无法获取 r${revision} 的日志详情`);
        }
        const body = entryMatch[2];
        const author = this.decodeXml(/<author>([\s\S]*?)<\/author>/.exec(body)?.[1] || '');
        const message = this.decodeXml(/<msg>([\s\S]*?)<\/msg>/.exec(body)?.[1] || '');
        const paths: Array<{ action: string; path: string }> = [];
        const pathRegex = /<path[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/path>/g;
        let pathMatch: RegExpExecArray | null;
        while ((pathMatch = pathRegex.exec(body)) !== null) {
            paths.push({ action: pathMatch[1], path: this.decodeXml(pathMatch[2].trim()) });
        }
        await this.generate({ revision: String(revision), author, message, paths }, targetPath);
    }

    public async generate(entry: PatchLogEntry, targetPath: string): Promise<void> {
        const projectDev = this.findProjectDev(targetPath);
        if (!projectDev) {
            throw new Error('无法找到 project_dev 目录，请从 client 工作副本内打开日志或提交面板');
        }
        if (!entry.paths?.length) {
            throw new Error(`r${entry.revision} 没有可用于生成 patch 的文件记录`);
        }

        const revision = Number(entry.revision);
        if (!Number.isInteger(revision) || revision <= 1) {
            throw new Error(`无效的 SVN 版本号: ${entry.revision}`);
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `正在根据 r${revision} 生成 patch...`,
            cancellable: false
        }, async progress => {
            progress.report({ message: '读取 SVN 版本信息' });
            const repoRoot = await this.getRepositoryRoot(targetPath);
            const mappings = await this.getPathMappings(projectDev, repoRoot);
            const configPaths = entry.paths!.filter(item => this.getConfigKind(item.path, mappings) !== undefined);
            const codePaths = entry.paths!.filter(item => this.getModuleName(item.path, mappings) !== undefined);

            let configPatch = '';
            if (configPaths.length > 0) {
                progress.report({ message: '生成配置表 patch' });
                configPatch = await this.generateConfigPatch(projectDev, repoRoot, revision, entry, configPaths, mappings);
            }

            let codePatch = '';
            if (codePaths.length > 0) {
                progress.report({ message: '分析 Lua 代码改动' });
                codePatch = await this.generateCodePatch(repoRoot, revision, entry, codePaths, configPatch, mappings);
            }

            if (!configPatch && !codePatch) {
                throw new Error('该日志没有可生成 patch 的 Lua 代码或配置表修改');
            }

            const body = codePatch || configPatch;
            const block = this.formatPatchBlock(body, entry);
            const patchFile = path.join(projectDev, 'src', 'patch.lua');
            await this.validateAndAppend(block, patchFile);
            const document = await vscode.workspace.openTextDocument(patchFile);
            await vscode.window.showTextDocument(document, { preview: false });
            vscode.window.showInformationMessage(`已将 r${revision} patch 追加到 patch.lua`);
        });
    }

    private findProjectDev(targetPath: string): string | undefined {
        let current = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
            ? targetPath
            : path.dirname(targetPath);
        while (true) {
            if (path.basename(current) === 'project_dev' && fs.existsSync(path.join(current, 'src'))) {
                return current;
            }
            const child = path.join(current, 'project_dev');
            if (fs.existsSync(path.join(child, 'src'))) {
                return child;
            }
            const parent = path.dirname(current);
            if (parent === current) { return undefined; }
            current = parent;
        }
    }

    private async getRepositoryRoot(targetPath: string): Promise<string> {
        const cwd = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
        const xml = await this.svnService.executeSvnCommand(`info --xml "${targetPath}"`, cwd, false);
        const match = /<root>([^<]+)<\/root>/.exec(xml);
        if (!match) {
            throw new Error('无法从 svn info 解析仓库根 URL');
        }
        return match[1].replace(/\/$/, '');
    }

    private async getPathMappings(projectDev: string, repoRoot: string): Promise<PatchPathMappings> {
        const entries: Array<[keyof PatchPathMappings, string]> = [
            ['clientConfig', path.join(projectDev, 'res', 'data')],
            ['battleConfig', path.join(projectDev, 'src', 'battle', 'cfg')],
            ['clientSource', path.join(projectDev, 'src')],
            ['battleSource', path.join(projectDev, 'src', 'battle')]
        ];
        const mappings: PatchPathMappings = {};
        await Promise.all(entries.map(async ([key, localPath]) => {
            if (!fs.existsSync(localPath)) { return; }
            try {
                const cwd = fs.statSync(localPath).isDirectory() ? localPath : path.dirname(localPath);
                const xml = await this.svnService.executeSvnCommand(`info --xml "${localPath}"`, cwd, false);
                const root = this.decodeXml(/<root>([^<]+)<\/root>/.exec(xml)?.[1] || '').replace(/\/$/, '');
                const url = this.decodeXml(/<url>([^<]+)<\/url>/.exec(xml)?.[1] || '').replace(/\/$/, '');
                if (root === repoRoot && url.startsWith(`${root}/`)) {
                    mappings[key] = url.slice(root.length);
                }
            } catch (error: any) {
                this.output.appendLine(`[PatchGenerator] 跳过路径映射 ${localPath}: ${error.message}`);
            }
        }));
        return mappings;
    }

    private relativeTo(filePath: string, prefix?: string): string | undefined {
        if (!prefix || !filePath.startsWith(`${prefix}/`)) { return undefined; }
        return filePath.slice(prefix.length + 1);
    }

    private getConfigKind(filePath: string, mappings: PatchPathMappings): 'client' | 'battle' | undefined {
        const clientRelative = this.relativeTo(filePath, mappings.clientConfig);
        if (clientRelative && !clientRelative.includes('/') && /\.lua$/i.test(clientRelative)) {
            return 'client';
        }
        const battleRelative = this.relativeTo(filePath, mappings.battleConfig);
        if (battleRelative && !battleRelative.includes('/') && /\.lua$/i.test(battleRelative)) {
            return 'battle';
        }
        return undefined;
    }

    private getModuleName(filePath: string, mappings: PatchPathMappings): string | undefined {
        const clientRelative = this.relativeTo(filePath, mappings.clientSource);
        if (clientRelative && /\.lua$/i.test(clientRelative) && !this.relativeTo(filePath, mappings.battleConfig)) {
            return clientRelative.replace(/\.lua$/i, '').replace(/\//g, '.');
        }
        const battleRelative = this.relativeTo(filePath, mappings.battleSource);
        if (battleRelative && /\.lua$/i.test(battleRelative) && !this.relativeTo(filePath, mappings.battleConfig)) {
            return `battle.${battleRelative.replace(/\.lua$/i, '').replace(/\//g, '.')}`;
        }
        return undefined;
    }

    private async generateConfigPatch(
        projectDev: string,
        repoRoot: string,
        revision: number,
        entry: PatchLogEntry,
        paths: Array<{ action: string; path: string }>,
        mappings: PatchPathMappings
    ): Promise<string> {
        const modified = paths.filter(item => item.action === 'M');
        if (modified.length !== paths.length) {
            throw new Error('配置表 patch 暂不支持新增或删除文件，请确认该日志仅修改已有配置表');
        }

        const dataPaths = modified.filter(item => this.getConfigKind(item.path, mappings) === 'client');
        const battlePaths = modified.filter(item => this.getConfigKind(item.path, mappings) === 'battle');
        const patches: string[] = [];
        if (dataPaths.length > 0) {
            patches.push(await this.runConfigGenerator(
                projectDev,
                repoRoot,
                revision,
                entry,
                dataPaths,
                'create_patch.lua',
                'patch.lua',
                path.join(projectDev, 'res', 'data'),
                true
            ));
        }
        if (battlePaths.length > 0) {
            patches.push(await this.runConfigGenerator(
                projectDev,
                repoRoot,
                revision,
                entry,
                battlePaths,
                'create_patch_battle.lua',
                'patch_battle.lua',
                path.join(projectDev, 'src', 'battle', 'cfg'),
                false
            ));
        }
        return patches.filter(Boolean).join('\n\n');
    }

    private async runConfigGenerator(
        projectDev: string,
        repoRoot: string,
        revision: number,
        entry: PatchLogEntry,
        paths: Array<{ action: string; path: string }>,
        generatorName: string,
        outputName: string,
        dataDir: string,
        withMetadata: boolean
    ): Promise<string> {
        const toolDir = path.join(projectDev, 'tools', '_配置表patch');
        const generator = path.join(toolDir, generatorName);
        if (!fs.existsSync(generator)) {
            throw new Error(`未找到配置表 patch 工具: ${generator}`);
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-svn-config-patch-'));
        const oldDir = path.join(tempDir, 'old');
        const newDir = path.join(tempDir, 'new');
        fs.mkdirSync(oldDir);
        fs.mkdirSync(newDir);
        fs.copyFileSync(generator, path.join(tempDir, generatorName));

        try {
            for (const item of paths) {
                const fileName = path.posix.basename(item.path);
                const url = `${repoRoot}${item.path}`;
                const oldContent = await this.svnService.executeSvnCommand(
                    `cat -r ${revision - 1} "${url}@${revision - 1}"`, projectDev, false
                );
                const newContent = await this.svnService.executeSvnCommand(
                    `cat -r ${revision} "${url}@${revision}"`, projectDev, false
                );
                fs.writeFileSync(path.join(oldDir, fileName), oldContent, 'utf8');
                fs.writeFileSync(path.join(newDir, fileName), newContent, 'utf8');
            }

            const args = [generatorName];
            if (withMetadata) {
                const localUser = os.userInfo().username;
                const author = entry.author && entry.author !== localUser ? `${localUser} for ${entry.author}` : localUser;
                args.push(dataDir, author, entry.message || `r${revision}`);
            }
            await this.execFile('lua', args, tempDir);
            const outputFile = path.join(tempDir, outputName);
            if (!fs.existsSync(outputFile)) {
                throw new Error(`${generatorName} 未生成 ${outputName}`);
            }
            return this.stripBoundaryMetadata(fs.readFileSync(outputFile, 'utf8'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    private async generateCodePatch(
        repoRoot: string,
        revision: number,
        entry: PatchLogEntry,
        paths: Array<{ action: string; path: string }>,
        configPatch: string,
        mappings: PatchPathMappings
    ): Promise<string> {
        const sections: string[] = [];
        let remaining = 120000;
        for (const item of paths) {
            if (remaining <= 0) { break; }
            const url = `${repoRoot}${item.path}`;
            let diff = '';
            let source = '';
            try {
                diff = await this.svnService.executeSvnCommand(
                    `diff -c ${revision} "${url}@${revision}"`, path.dirname(__filename), false
                );
            } catch (error: any) {
                diff = `无法获取差异: ${error.message}`;
            }
            if (item.action !== 'D') {
                try {
                    source = await this.svnService.executeSvnCommand(
                        `cat -r ${revision} "${url}@${revision}"`, path.dirname(__filename), false
                    );
                } catch (error: any) {
                    source = `无法获取完整源码: ${error.message}`;
                }
            }
            const moduleName = this.getModuleName(item.path, mappings);
            const section = `文件: ${item.path} (${item.action})\nrequire 路径: ${moduleName}\nDIFF:\n${diff}\n\nr${revision} 完整源码:\n${source}`;
            sections.push(section.slice(0, remaining));
            remaining -= section.length;
        }

        const instruction = '你是资深 Lua 热更新工程师。只输出可直接执行的完整 patch.lua 源码，不要 Markdown 代码块、解释或省略号。';
        const prompt = `请根据单个 SVN 日志生成 Lua 热更新 patch。\n\n` +
            `版本: r${revision}\n作者: ${entry.author}\n提交信息: ${entry.message}\n\n` +
            `强制规则：\n` +
            `1. 只输出本次 revision 的 patch 正文，不输出 require("patch_always")，不生成版本、作者、变更说明、start/end 或分隔线；扩展会统一追加头尾注释。\n` +
            `2. 每个模块代码前只写一行“-- require路径”，随后定义 local 模块变量和完整替换函数，例如“-- app.views.xxx”下一行“local Xxx = require("app.views.xxx")”。\n` +
            `3. 正文末尾严格使用“-- QA测试用例：”标题，后续每条使用“-- 1. ...；”格式，不添加其他尾部说明。\n` +
            `4. 只处理本次 revision，不包含已有 patch.lua 内容。\n` +
            `5. 必须使用变更材料中给出的 require 路径。\n` +
            `6. 必须重定义受影响的完整公开函数，保持冒号/点号和参数完全一致。\n` +
            `7. 原文件顶层 local/upvalue 在 patch 中不可见，必须重新 require 或重新声明。\n` +
            `8. local function 不能直接替换，需内联到公开调用者。\n` +
            `9. EMAP/TMAP/AMAP 保存旧函数引用时，重定义后必须同步重绑。\n` +
            (configPatch ? `10. 以下配置表 patch 必须原样包含在正文中：\n${configPatch}\n\n` : '') +
            `变更材料：\n${sections.join('\n\n====================\n\n')}`;

        const result = await this.aiService.generateText(prompt, instruction, `正在生成 r${revision} Lua patch...`);
        if (!result.trim()) {
            throw new Error('AI 未返回 Lua patch 内容');
        }
        return result;
    }

    private decodeXml(value: string): string {
        return value
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    }

    private stripCodeFence(content: string): string {
        return content
            .replace(/^\s*```(?:lua)?\s*/i, '')
            .replace(/\s*```\s*$/i, '');
    }

    private stripBoundaryMetadata(content: string): string {
        const lines = content.trim().split(/\r?\n/);
        if (lines[0]?.trim() === '--[[') {
            const closing = lines.findIndex((line, index) => index > 0 && line.trim() === ']]');
            if (closing > 0 && lines.slice(1, closing).some(line => line.trim() === 'start')) {
                lines.splice(0, closing + 1);
            }
        }

        let opening = -1;
        for (let index = lines.length - 1; index >= 0; index--) {
            if (lines[index].trim() === '--[[') {
                opening = index;
                break;
            }
        }
        if (opening >= 0 && lines.slice(opening + 1).some(line => line.trim() === 'end')) {
            lines.splice(opening);
        }
        return lines.join('\n').trim();
    }

    private formatPatchBlock(content: string, entry: PatchLogEntry): string {
        let body = this.stripCodeFence(content).trim();
        body = body.replace(/^require\s*\(\s*["']patch_always["']\s*\)\s*;?\s*/i, '');
        body = this.stripBoundaryMetadata(body);

        const message = (entry.message.trim() || `r${entry.revision}`).replace(/\]\]/g, '] ]');
        const author = (entry.author.trim() || os.userInfo().username).replace(/[\r\n]+/g, ' ').replace(/\]\]/g, '] ]');
        const start = `--[[\n${message}\nby ${author}\nstart\n]]`;
        const end = `--[[\n${message}\nby ${author}\nend\n]]`;
        return `${start}\n\n${body}\n\n${end}`;
    }

    private async validateAndAppend(block: string, patchFile: string): Promise<void> {
        const existing = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8').trimEnd() : '';
        const prefix = existing || 'require("patch_always")';
        const content = `${prefix}\n\n${block.trim()}\n`;
        const tempFile = path.join(os.tmpdir(), `vscode-svn-patch-${Date.now()}.lua`);
        fs.writeFileSync(tempFile, content, 'utf8');
        try {
            try {
                await this.execFile('luac', ['-p', tempFile], path.dirname(patchFile));
            } catch (error: any) {
                if (error.code !== 'ENOENT') {
                    throw new Error(`生成的 patch.lua 语法检查失败: ${error.message}`);
                }
                this.output.appendLine('[PatchGenerator] 未找到 luac，跳过语法检查');
            }
            fs.writeFileSync(patchFile, content, 'utf8');
        } finally {
            fs.rmSync(tempFile, { force: true });
        }
    }

    private execFile(command: string, args: string[], cwd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.execFile(command, args, { cwd, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
                if (error) {
                    reject(Object.assign(new Error(stderr || error.message), { code: (error as any).code }));
                    return;
                }
                resolve(stdout);
            });
        });
    }
}

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

// 在后台启动项目进程，把 stdout/stderr 打到独立输出通道，不占用终端
let runnerChannel: vscode.OutputChannel | undefined;
let runningProcess: ChildProcess | undefined;

function getRunnerChannel(): vscode.OutputChannel {
    if (!runnerChannel) {
        runnerChannel = vscode.window.createOutputChannel('项目运行');
    }
    return runnerChannel;
}

// 只支持 ${workspaceFolder} 变量，和 tasks.json 写法保持一致
function resolveVars(text: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return text.replace(/\$\{workspaceFolder\}/g, folder);
}

export async function runProject(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vscode-svn');
    const rawCommand = cfg.get<string>('runProject.command', '');
    if (!rawCommand) {
        const pick = await vscode.window.showWarningMessage(
            '未配置启动命令，请先设置 vscode-svn.runProject.command', '打开设置');
        if (pick) {
            vscode.commands.executeCommand('workbench.action.openSettings', 'vscode-svn.runProject');
        }
        return;
    }
    const command = resolveVars(rawCommand);
    const cwd = resolveVars(cfg.get<string>('runProject.cwd', '${workspaceFolder}'));

    stopProject(true);

    const channel = getRunnerChannel();
    channel.clear();
    channel.show(true);
    channel.appendLine(`[cwd] ${cwd}`);
    channel.appendLine(`[run] ${command}`);
    channel.appendLine('');

    // detached 让 sh 成为进程组组长，停止时可以连带杀掉真正的程序
    const isWin = process.platform === 'win32';
    const child = spawn(command, { cwd, shell: true, env: process.env, detached: !isWin });
    runningProcess = child;
    child.stdout?.on('data', (d: Buffer) => channel.append(d.toString()));
    child.stderr?.on('data', (d: Buffer) => channel.append(d.toString()));
    child.on('error', (err) => channel.appendLine(`[error] ${err.message}`));
    child.on('close', (code, signal) => {
        channel.appendLine('');
        channel.appendLine(`[exit] code=${code} signal=${signal ?? ''}`);
        if (runningProcess === child) {
            runningProcess = undefined;
        }
    });
}

export function stopProject(silent = false): void {
    if (!runningProcess) {
        if (!silent) {
            vscode.window.showInformationMessage('当前没有正在运行的项目进程');
        }
        return;
    }
    const child = runningProcess;
    runningProcess = undefined;
    try {
        if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, 'SIGTERM');
        } else {
            child.kill();
        }
    } catch {
        child.kill();
    }
    getRunnerChannel().appendLine('[stop] 已终止项目进程');
}

export function disposeProjectRunner(): void {
    stopProject(true);
    runnerChannel?.dispose();
    runnerChannel = undefined;
}

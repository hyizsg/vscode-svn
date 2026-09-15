import * as vscode from 'vscode';

// 全插件共用同一个输出通道，避免各面板/服务各自创建导致输出下拉出现大量重复条目
let sharedOutputChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!sharedOutputChannel) {
        sharedOutputChannel = vscode.window.createOutputChannel('SVN');
    }
    return sharedOutputChannel;
}

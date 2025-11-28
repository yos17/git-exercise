import * as vscode from 'vscode';

export class OutputManager {
    private outputChannel: vscode.OutputChannel;
    private logChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('SAS Output');
        this.logChannel = vscode.window.createOutputChannel('SAS Log');
    }

    log(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.logChannel.appendLine(`[${timestamp}] ${message}`);
    }

    error(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.logChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
    }

    output(content: string): void {
        this.outputChannel.appendLine(content);
    }

    show(): void {
        this.logChannel.show(true);
    }

    showOutput(): void {
        this.outputChannel.show(true);
    }

    clear(): void {
        this.outputChannel.clear();
        this.logChannel.clear();
    }

    dispose(): void {
        this.outputChannel.dispose();
        this.logChannel.dispose();
    }
}

import * as vscode from 'vscode';

/**
 * Custom output channel for SAS log with syntax highlighting
 */
export class SASLogOutputChannel implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('SAS Log', 'sas-log');
    }

    /**
     * Append text to the log
     */
    appendLine(text: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${text}`);
    }

    /**
     * Append raw SAS log output with parsing
     */
    appendSASLog(log: string): void {
        const lines = log.split('\n');

        for (const line of lines) {
            if (line.includes('ERROR:')) {
                this.outputChannel.appendLine(`❌ ${line}`);
            } else if (line.includes('WARNING:')) {
                this.outputChannel.appendLine(`⚠️ ${line}`);
            } else if (line.includes('NOTE:')) {
                this.outputChannel.appendLine(`📝 ${line}`);
            } else if (line.startsWith('MLOGIC') || line.startsWith('MPRINT') || line.startsWith('SYMBOLGEN')) {
                this.outputChannel.appendLine(`🔧 ${line}`);
            } else {
                this.outputChannel.appendLine(line);
            }
        }
    }

    /**
     * Show the output channel
     */
    show(preserveFocus?: boolean): void {
        this.outputChannel.show(preserveFocus);
    }

    /**
     * Clear the log
     */
    clear(): void {
        this.outputChannel.clear();
    }

    /**
     * Dispose of the output channel
     */
    dispose(): void {
        this.outputChannel.dispose();
    }
}

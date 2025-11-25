import * as vscode from 'vscode';
import { SASConnectionManager } from './connectionManager';
import { SASLogOutputChannel } from '../utils/logChannel';
import { SASExecutionResult } from './sasConnection';

/**
 * Handles SAS code execution outside of debugging sessions
 */
export class SASCodeRunner {
    private connectionManager: SASConnectionManager;
    private logChannel: SASLogOutputChannel;
    private outputChannel: vscode.OutputChannel;

    constructor(connectionManager: SASConnectionManager, logChannel: SASLogOutputChannel) {
        this.connectionManager = connectionManager;
        this.logChannel = logChannel;
        this.outputChannel = vscode.window.createOutputChannel('SAS Output');
    }

    /**
     * Run SAS code and display results
     */
    async runCode(code: string): Promise<SASExecutionResult> {
        // Show log channel
        this.logChannel.show();

        // Clear previous output
        this.outputChannel.clear();

        try {
            // Submit code
            const result = await this.connectionManager.submit(code);

            // Display output
            if (result.output) {
                this.outputChannel.appendLine(result.output);
                this.outputChannel.show(true);
            }

            // Show diagnostics for errors
            this.showDiagnostics(result);

            return result;
        } catch (error) {
            vscode.window.showErrorMessage(`SAS execution error: ${error}`);
            throw error;
        }
    }

    /**
     * Run code from file
     */
    async runFile(filePath: string): Promise<SASExecutionResult> {
        const fs = await import('fs');
        const code = fs.readFileSync(filePath, 'utf-8');
        return this.runCode(code);
    }

    /**
     * Show diagnostics for SAS errors
     */
    private showDiagnostics(result: SASExecutionResult): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'sas') {
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];

        for (const error of result.errors) {
            const range = new vscode.Range(
                error.line - 1,
                error.column ? error.column - 1 : 0,
                error.line - 1,
                1000
            );

            const diagnostic = new vscode.Diagnostic(
                range,
                error.message,
                vscode.DiagnosticSeverity.Error
            );

            if (error.code) {
                diagnostic.code = error.code;
            }

            diagnostics.push(diagnostic);
        }

        // Create diagnostic collection if needed
        const collection = vscode.languages.createDiagnosticCollection('sas');
        collection.set(editor.document.uri, diagnostics);
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}

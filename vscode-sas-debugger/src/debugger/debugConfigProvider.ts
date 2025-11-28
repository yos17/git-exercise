import * as vscode from 'vscode';
import { SASConnectionManager } from '../connection/connectionManager';

export class SASDebugConfigProvider implements vscode.DebugConfigurationProvider {
    private connection: SASConnectionManager;

    constructor(connection: SASConnectionManager) {
        this.connection = connection;
    }

    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // If no config, create a default one
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'sas') {
                config.type = 'sas';
                config.name = 'Debug SAS Program';
                config.request = 'launch';
                config.program = '${file}';
                config.debugDataSteps = true;
                config.debugMacros = true;
                config.stopOnEntry = true;
            }
        }

        if (!config.program) {
            return vscode.window.showInformationMessage('Cannot find a SAS program to debug').then(_ => {
                return undefined;
            });
        }

        // Resolve ${file} and other variables
        if (config.program === '${file}') {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                config.program = editor.document.uri.fsPath;
            }
        }

        return config;
    }

    provideDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined,
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                type: 'sas',
                request: 'launch',
                name: 'Debug SAS Program',
                program: '${file}',
                debugDataSteps: true,
                debugMacros: true,
                stopOnEntry: true
            },
            {
                type: 'sas',
                request: 'launch',
                name: 'Debug DATA Steps Only',
                program: '${file}',
                debugDataSteps: true,
                debugMacros: false,
                stopOnEntry: true
            },
            {
                type: 'sas',
                request: 'launch',
                name: 'Debug Macros Only',
                program: '${file}',
                debugDataSteps: false,
                debugMacros: true,
                stopOnEntry: true
            }
        ];
    }
}

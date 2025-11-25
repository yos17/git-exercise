import * as vscode from 'vscode';
import { SASDebugAdapterFactory } from './debugger/debugAdapterFactory';
import { SASConnectionManager } from './connection/connectionManager';
import { DatasetViewerProvider } from './viewer/datasetViewerProvider';
import { LibraryTreeProvider } from './viewer/libraryTreeProvider';
import { MacroVariablesProvider } from './viewer/macroVariablesProvider';
import { PDVProvider } from './viewer/pdvProvider';
import { SASLogOutputChannel } from './utils/logChannel';
import { SASCodeRunner } from './connection/codeRunner';

let connectionManager: SASConnectionManager;
let logChannel: SASLogOutputChannel;

export function activate(context: vscode.ExtensionContext) {
    console.log('SAS Debugger extension is now active');

    // Initialize log channel
    logChannel = new SASLogOutputChannel();
    context.subscriptions.push(logChannel);

    // Initialize connection manager
    connectionManager = new SASConnectionManager(context, logChannel);

    // Initialize code runner
    const codeRunner = new SASCodeRunner(connectionManager, logChannel);

    // Register debug adapter factory
    const debugAdapterFactory = new SASDebugAdapterFactory(connectionManager, logChannel);
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('sas', debugAdapterFactory)
    );

    // Register tree view providers
    const libraryProvider = new LibraryTreeProvider(connectionManager);
    const macroVarsProvider = new MacroVariablesProvider(connectionManager);
    const pdvProvider = new PDVProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('sasLibraries', libraryProvider),
        vscode.window.registerTreeDataProvider('sasMacroVariables', macroVarsProvider),
        vscode.window.registerTreeDataProvider('sasPDV', pdvProvider)
    );

    // Register dataset viewer
    const datasetViewerProvider = new DatasetViewerProvider(context.extensionUri, connectionManager);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('sasDatasetViewer', datasetViewerProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('sasDebugger.connectToSAS', async () => {
            await connectionManager.connect();
            vscode.commands.executeCommand('setContext', 'sasDebugger.connected', true);
            libraryProvider.refresh();
        }),

        vscode.commands.registerCommand('sasDebugger.disconnectFromSAS', async () => {
            await connectionManager.disconnect();
            vscode.commands.executeCommand('setContext', 'sasDebugger.connected', false);
        }),

        vscode.commands.registerCommand('sasDebugger.runCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'sas') {
                const selection = editor.selection;
                const code = selection.isEmpty
                    ? editor.document.getText()
                    : editor.document.getText(selection);
                await codeRunner.runCode(code);
            }
        }),

        vscode.commands.registerCommand('sasDebugger.runFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'sas') {
                await codeRunner.runCode(editor.document.getText());
            }
        }),

        vscode.commands.registerCommand('sasDebugger.viewDataset', async (uri?: vscode.Uri) => {
            if (uri) {
                await datasetViewerProvider.openDataset(uri.fsPath);
            } else {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter library.dataset name or path to SAS7BDAT file',
                    placeHolder: 'work.mydata or /path/to/file.sas7bdat'
                });
                if (input) {
                    await datasetViewerProvider.openDataset(input);
                }
            }
        }),

        vscode.commands.registerCommand('sasDebugger.browseLibraries', () => {
            libraryProvider.refresh();
            vscode.commands.executeCommand('sasLibraries.focus');
        }),

        vscode.commands.registerCommand('sasDebugger.showMacroVariables', () => {
            macroVarsProvider.refresh();
            vscode.commands.executeCommand('sasMacroVariables.focus');
        }),

        vscode.commands.registerCommand('sasDebugger.clearLog', () => {
            logChannel.clear();
        }),

        vscode.commands.registerCommand('sasDebugger.refreshLibraries', () => {
            libraryProvider.refresh();
        }),

        vscode.commands.registerCommand('sasDebugger.openDatasetFromTree', async (item: { libname: string; dataset: string }) => {
            await datasetViewerProvider.openDataset(`${item.libname}.${item.dataset}`);
        })
    );

    // Auto-connect if configured
    const config = vscode.workspace.getConfiguration('sasDebugger');
    if (config.get<boolean>('autoConnect')) {
        connectionManager.connect().then(() => {
            vscode.commands.executeCommand('setContext', 'sasDebugger.connected', true);
        }).catch(() => {
            // Silent fail on auto-connect
        });
    }

    logChannel.appendLine('SAS Debugger extension activated');
}

export function deactivate() {
    if (connectionManager) {
        connectionManager.disconnect();
    }
}

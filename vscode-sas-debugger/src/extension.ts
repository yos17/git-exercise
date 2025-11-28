import * as vscode from 'vscode';
import { SASConnectionManager } from './connection/connectionManager';
import { AIAssistant } from './ai/aiAssistant';
import { DataAnonymizer } from './anonymizer/dataAnonymizer';
import { LibraryTreeProvider } from './views/libraryTreeProvider';
import { MacroVarsProvider } from './views/macroVarsProvider';
import { DatasetViewerPanel } from './views/datasetViewer';
import { SASDebugConfigProvider } from './debugger/debugConfigProvider';
import { OutputManager } from './utils/outputManager';

let connectionManager: SASConnectionManager;
let aiAssistant: AIAssistant;
let dataAnonymizer: DataAnonymizer;
let outputManager: OutputManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('SAS Studio AI is activating...');

    // Initialize core services
    outputManager = new OutputManager();
    connectionManager = new SASConnectionManager(outputManager);
    aiAssistant = new AIAssistant(context);
    dataAnonymizer = new DataAnonymizer(connectionManager);

    // Register tree data providers
    const libraryProvider = new LibraryTreeProvider(connectionManager);
    const macroVarsProvider = new MacroVarsProvider(connectionManager);

    vscode.window.registerTreeDataProvider('sasLibraries', libraryProvider);
    vscode.window.registerTreeDataProvider('sasMacroVars', macroVarsProvider);

    // Register debug configuration provider
    const debugConfigProvider = new SASDebugConfigProvider(connectionManager);
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('sas', debugConfigProvider)
    );

    // Register commands
    registerCommands(context, libraryProvider, macroVarsProvider);

    // Set up status bar
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(plug) SAS: Disconnected';
    statusBarItem.command = 'sasStudioAI.connect';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Update status bar on connection changes
    connectionManager.onConnectionChange((connected) => {
        if (connected) {
            statusBarItem.text = '$(check) SAS: Connected';
            statusBarItem.backgroundColor = undefined;
            libraryProvider.refresh();
            macroVarsProvider.refresh();
        } else {
            statusBarItem.text = '$(plug) SAS: Disconnected';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    });

    outputManager.log('SAS Studio AI activated successfully');
}

function registerCommands(
    context: vscode.ExtensionContext,
    libraryProvider: LibraryTreeProvider,
    macroVarsProvider: MacroVarsProvider
): void {
    // Connection commands
    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.connect', async () => {
            await showConnectionPicker();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.disconnect', async () => {
            await connectionManager.disconnect();
            vscode.window.showInformationMessage('Disconnected from SAS');
        })
    );

    // Run commands
    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.runCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const selection = editor.selection;
            const code = selection.isEmpty
                ? editor.document.getText()
                : editor.document.getText(selection);

            await runSASCode(code);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.runFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            await runSASCode(editor.document.getText());
        })
    );

    // Dataset commands
    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.viewDataset', async (item?: any) => {
            let libref: string;
            let dataset: string;

            if (item && item.libref && item.dataset) {
                libref = item.libref;
                dataset = item.dataset;
            } else {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter dataset name (e.g., WORK.MYDATA or SASHELP.CARS)',
                    placeHolder: 'LIBREF.DATASET'
                });
                if (!input) return;

                const parts = input.toUpperCase().split('.');
                if (parts.length !== 2) {
                    vscode.window.showErrorMessage('Invalid dataset name. Use format: LIBREF.DATASET');
                    return;
                }
                [libref, dataset] = parts;
            }

            await DatasetViewerPanel.show(context.extensionUri, connectionManager, libref, dataset);
        })
    );

    // Anonymize dataset command - KEY SECURITY FEATURE
    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.anonymizeDataset', async (item?: any) => {
            let libref: string;
            let dataset: string;

            if (item && item.libref && item.dataset) {
                libref = item.libref;
                dataset = item.dataset;
            } else {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter dataset to anonymize (e.g., WORK.MYDATA)',
                    placeHolder: 'LIBREF.DATASET'
                });
                if (!input) return;

                const parts = input.toUpperCase().split('.');
                if (parts.length !== 2) {
                    vscode.window.showErrorMessage('Invalid dataset name');
                    return;
                }
                [libref, dataset] = parts;
            }

            await anonymizeAndExport(libref, dataset);
        })
    );

    // AI commands
    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.aiExplain', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const selection = editor.selection;
            const code = selection.isEmpty
                ? editor.document.getText()
                : editor.document.getText(selection);

            await aiAssistant.explainCode(code);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.aiGenerate', async () => {
            const description = await vscode.window.showInputBox({
                prompt: 'Describe what SAS code you want to generate',
                placeHolder: 'e.g., Create a proc means to analyze sales by region'
            });
            if (!description) return;

            await aiAssistant.generateCode(description);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.aiOptimize', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const selection = editor.selection;
            const code = selection.isEmpty
                ? editor.document.getText()
                : editor.document.getText(selection);

            await aiAssistant.optimizeCode(code);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.aiDebugHelp', async () => {
            const errorLog = await vscode.window.showInputBox({
                prompt: 'Paste the SAS error message or log',
                placeHolder: 'ERROR: ...'
            });
            if (!errorLog) return;

            const editor = vscode.window.activeTextEditor;
            const code = editor ? editor.document.getText() : '';

            await aiAssistant.debugError(errorLog, code);
        })
    );

    // Refresh commands
    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.refreshLibraries', () => {
            libraryProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sasStudioAI.refreshMacroVars', () => {
            macroVarsProvider.refresh();
        })
    );
}

async function showConnectionPicker(): Promise<void> {
    const config = vscode.workspace.getConfiguration('sasStudioAI');
    const profiles: any[] = config.get('connections') || [];

    const items: vscode.QuickPickItem[] = [
        {
            label: '$(add) Add New Connection',
            description: 'Create a new SAS connection profile'
        },
        {
            label: '$(cloud) SAS OnDemand for Academics (Free)',
            description: 'Connect to free SAS cloud environment'
        },
        ...profiles.map(p => ({
            label: `$(server) ${p.name}`,
            description: `${p.type.toUpperCase()} - ${p.host || 'local'}`
        }))
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a SAS connection'
    });

    if (!selected) return;

    if (selected.label.includes('Add New Connection')) {
        await createNewConnection();
    } else if (selected.label.includes('OnDemand for Academics')) {
        await connectToSODA();
    } else {
        const profileName = selected.label.replace('$(server) ', '');
        const profile = profiles.find(p => p.name === profileName);
        if (profile) {
            await connectionManager.connect(profile);
        }
    }
}

async function createNewConnection(): Promise<void> {
    const connectionType = await vscode.window.showQuickPick(
        [
            { label: 'SAS OnDemand for Academics', value: 'soda' },
            { label: 'SAS Viya', value: 'viya' },
            { label: 'SAS 9.4 (IOM)', value: 'iom' },
            { label: 'SSH to SAS Server', value: 'ssh' }
        ],
        { placeHolder: 'Select connection type' }
    );

    if (!connectionType) return;

    const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for this connection',
        placeHolder: 'My SAS Server'
    });

    if (!name) return;

    const profile: any = { name, type: connectionType.value };

    if (connectionType.value !== 'soda') {
        profile.host = await vscode.window.showInputBox({
            prompt: 'Enter server hostname',
            placeHolder: 'sas.company.com'
        });

        profile.username = await vscode.window.showInputBox({
            prompt: 'Enter username'
        });
    }

    // Save profile
    const config = vscode.workspace.getConfiguration('sasStudioAI');
    const profiles: any[] = config.get('connections') || [];
    profiles.push(profile);
    await config.update('connections', profiles, vscode.ConfigurationTarget.Global);

    vscode.window.showInformationMessage(`Connection "${name}" saved`);
}

async function connectToSODA(): Promise<void> {
    const region = await vscode.window.showQuickPick(
        [
            { label: 'United States', value: 'us' },
            { label: 'Europe', value: 'eu' },
            { label: 'Asia Pacific', value: 'ap' }
        ],
        { placeHolder: 'Select your region' }
    );

    if (!region) return;

    await connectionManager.connect({
        type: 'soda',
        region: region.value
    });
}

async function runSASCode(code: string): Promise<void> {
    if (!connectionManager.isConnected()) {
        const connect = await vscode.window.showWarningMessage(
            'Not connected to SAS. Connect now?',
            'Connect', 'Cancel'
        );
        if (connect !== 'Connect') return;
        await showConnectionPicker();
        if (!connectionManager.isConnected()) return;
    }

    outputManager.log('Submitting SAS code...');
    outputManager.show();

    try {
        const result = await connectionManager.submit(code);
        outputManager.log(result.log);

        if (result.hasErrors) {
            vscode.window.showErrorMessage('SAS code completed with errors. Check the output.');
        } else {
            vscode.window.showInformationMessage('SAS code completed successfully');
        }
    } catch (error) {
        outputManager.error(`Error: ${error}`);
        vscode.window.showErrorMessage(`Failed to run SAS code: ${error}`);
    }
}

async function anonymizeAndExport(libref: string, dataset: string): Promise<void> {
    if (!connectionManager.isConnected()) {
        vscode.window.showErrorMessage('Not connected to SAS');
        return;
    }

    // Show anonymization options
    const method = await vscode.window.showQuickPick(
        [
            {
                label: '$(shield) Synthetic Data Generation',
                description: 'Generate statistically similar fake data',
                value: 'synthetic'
            },
            {
                label: '$(shuffle) Shuffle Values',
                description: 'Randomly shuffle values within columns',
                value: 'shuffle'
            },
            {
                label: '$(key) Mask Sensitive Fields',
                description: 'Replace sensitive data with masked values',
                value: 'mask'
            },
            {
                label: '$(pulse) Random Noise',
                description: 'Add random noise to numeric values',
                value: 'noise'
            }
        ],
        { placeHolder: 'Select anonymization method' }
    );

    if (!method) return;

    // Select output format
    const format = await vscode.window.showQuickPick(
        [
            { label: 'CSV', value: 'csv' },
            { label: 'JSON', value: 'json' },
            { label: 'Excel (XLSX)', value: 'xlsx' },
            { label: 'SAS Dataset (to WORK)', value: 'sas' }
        ],
        { placeHolder: 'Select output format' }
    );

    if (!format) return;

    // Select output location
    let outputPath: string | undefined;
    if (format.value !== 'sas') {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${dataset}_anonymized.${format.value}`),
            filters: {
                [format.label]: [format.value]
            }
        });
        if (!uri) return;
        outputPath = uri.fsPath;
    }

    // Show progress
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Anonymizing ${libref}.${dataset}...`,
            cancellable: false
        },
        async (progress) => {
            try {
                progress.report({ message: 'Analyzing dataset structure...' });

                const result = await dataAnonymizer.anonymize({
                    libref,
                    dataset,
                    method: method.value as any,
                    outputFormat: format.value as any,
                    outputPath,
                    preserveDistribution: true
                });

                if (result.success) {
                    vscode.window.showInformationMessage(
                        `Successfully anonymized ${result.rowCount} rows. ${
                            outputPath ? `Saved to: ${outputPath}` : 'Saved to WORK.' + dataset + '_ANON'
                        }`
                    );
                } else {
                    vscode.window.showErrorMessage(`Anonymization failed: ${result.error}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Anonymization error: ${error}`);
            }
        }
    );
}

export function deactivate(): void {
    if (connectionManager) {
        connectionManager.disconnect();
    }
}

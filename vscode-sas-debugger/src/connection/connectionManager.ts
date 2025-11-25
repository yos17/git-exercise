import * as vscode from 'vscode';
import {
    SASConnection,
    SASConnectionFactory,
    SASExecutionResult,
    SASLibrary,
    SASDataset,
    SASVariable,
    ConnectionProfile
} from './sasConnection';
import { SASLogOutputChannel } from '../utils/logChannel';

/**
 * Manages SAS connections throughout the extension lifecycle
 */
export class SASConnectionManager {
    private context: vscode.ExtensionContext;
    private logChannel: SASLogOutputChannel;
    private connection: SASConnection | null = null;
    private currentProfile: string | null = null;

    private readonly _onConnectionChanged = new vscode.EventEmitter<boolean>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;

    constructor(context: vscode.ExtensionContext, logChannel: SASLogOutputChannel) {
        this.context = context;
        this.logChannel = logChannel;
    }

    /**
     * Get whether we're currently connected
     */
    get isConnected(): boolean {
        return this.connection?.isConnected ?? false;
    }

    /**
     * Get the current connection
     */
    getConnection(): SASConnection | null {
        return this.connection;
    }

    /**
     * Connect to SAS using the specified or default profile
     */
    async connect(profileName?: string): Promise<void> {
        // If already connected, disconnect first
        if (this.connection?.isConnected) {
            await this.disconnect();
        }

        const profile = profileName || await this.selectProfile();
        if (!profile) {
            throw new Error('No connection profile selected');
        }

        try {
            this.logChannel.appendLine(`Connecting to SAS using profile: ${profile}`);
            this.connection = await SASConnectionFactory.create(profile);
            await this.connection.connect();
            this.currentProfile = profile;

            this.logChannel.appendLine(`Successfully connected to SAS (${this.connection.connectionType})`);
            this._onConnectionChanged.fire(true);

            vscode.window.showInformationMessage(`Connected to SAS: ${profile}`);
        } catch (error) {
            this.logChannel.appendLine(`Connection failed: ${error}`);
            vscode.window.showErrorMessage(`Failed to connect to SAS: ${error}`);
            throw error;
        }
    }

    /**
     * Disconnect from SAS
     */
    async disconnect(): Promise<void> {
        if (this.connection) {
            try {
                await this.connection.disconnect();
                this.logChannel.appendLine('Disconnected from SAS');
            } catch (error) {
                this.logChannel.appendLine(`Disconnect error: ${error}`);
            } finally {
                this.connection = null;
                this.currentProfile = null;
                this._onConnectionChanged.fire(false);
            }
        }
    }

    /**
     * Submit SAS code
     */
    async submit(code: string): Promise<SASExecutionResult> {
        if (!this.connection?.isConnected) {
            // Try to auto-connect
            await this.connect();
        }

        if (!this.connection) {
            throw new Error('Not connected to SAS');
        }

        this.logChannel.appendLine('Submitting SAS code...');
        const result = await this.connection.submit(code);

        // Log the results
        if (result.log) {
            this.logChannel.appendSASLog(result.log);
        }

        if (result.errors.length > 0) {
            this.logChannel.appendLine(`Execution completed with ${result.errors.length} error(s)`);
        } else {
            this.logChannel.appendLine('Execution completed successfully');
        }

        return result;
    }

    /**
     * Send a debug command
     */
    async sendDebugCommand(command: string): Promise<string> {
        if (!this.connection?.isConnected) {
            throw new Error('Not connected to SAS');
        }

        return await this.connection.sendDebugCommand(command);
    }

    /**
     * Get list of libraries
     */
    async getLibraries(): Promise<SASLibrary[]> {
        if (!this.connection?.isConnected) {
            return [];
        }

        return await this.connection.getLibraries();
    }

    /**
     * Get datasets in a library
     */
    async getDatasets(library: string): Promise<SASDataset[]> {
        if (!this.connection?.isConnected) {
            return [];
        }

        return await this.connection.getDatasets(library);
    }

    /**
     * Get variables in a dataset
     */
    async getVariables(library: string, dataset: string): Promise<SASVariable[]> {
        if (!this.connection?.isConnected) {
            return [];
        }

        return await this.connection.getVariables(library, dataset);
    }

    /**
     * Get data from a dataset
     */
    async getData(
        library: string,
        dataset: string,
        options?: {
            where?: string;
            firstObs?: number;
            obs?: number;
            keep?: string[];
            drop?: string[];
        }
    ): Promise<{ columns: SASVariable[]; rows: any[][] }> {
        if (!this.connection?.isConnected) {
            throw new Error('Not connected to SAS');
        }

        return await this.connection.getData(library, dataset, options);
    }

    /**
     * Show profile selection QuickPick
     */
    private async selectProfile(): Promise<string | undefined> {
        const config = vscode.workspace.getConfiguration('sasDebugger');
        const profiles = config.get<ConnectionProfile[]>('connectionProfiles') || [];
        const defaultProfile = config.get<string>('defaultProfile');

        if (profiles.length === 0) {
            // Offer to create a profile
            const create = await vscode.window.showInformationMessage(
                'No SAS connection profiles configured. Would you like to create one?',
                'Create Profile',
                'Use Default'
            );

            if (create === 'Create Profile') {
                await this.createProfile();
                return this.selectProfile();
            } else if (create === 'Use Default') {
                return 'default';
            }
            return undefined;
        }

        if (profiles.length === 1) {
            return profiles[0].name;
        }

        const items = profiles.map(p => ({
            label: p.name,
            description: `${p.type}${p.host ? ' - ' + p.host : ''}`,
            detail: p.name === defaultProfile ? '(Default)' : undefined
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a SAS connection profile'
        });

        return selected?.label;
    }

    /**
     * Create a new connection profile
     */
    private async createProfile(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Profile name',
            value: 'default'
        });

        if (!name) return;

        const type = await vscode.window.showQuickPick(
            [
                { label: 'saspy', description: 'SASPy (Python) - Local or remote SAS' },
                { label: 'viya', description: 'SAS Viya REST API' },
                { label: 'iom', description: 'IOM (Java) - SAS 9.4 Workspace' }
            ],
            { placeHolder: 'Select connection type' }
        );

        if (!type) return;

        const profile: ConnectionProfile = {
            name,
            type: type.label as 'saspy' | 'iom' | 'viya'
        };

        if (type.label === 'saspy') {
            const sasPath = await vscode.window.showInputBox({
                prompt: 'Path to SAS executable (leave empty for default)',
                placeHolder: '/usr/local/SAS/SASFoundation/9.4/sas'
            });
            if (sasPath) {
                profile.sasPath = sasPath;
            }
        } else {
            const host = await vscode.window.showInputBox({
                prompt: 'SAS server hostname',
                placeHolder: 'sas.example.com'
            });
            if (host) {
                profile.host = host;
            }

            const portStr = await vscode.window.showInputBox({
                prompt: 'Port number',
                value: type.label === 'viya' ? '443' : '8591'
            });
            if (portStr) {
                profile.port = parseInt(portStr, 10);
            }
        }

        // Save profile
        const config = vscode.workspace.getConfiguration('sasDebugger');
        const profiles = config.get<ConnectionProfile[]>('connectionProfiles') || [];
        profiles.push(profile);
        await config.update('connectionProfiles', profiles, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(`Profile "${name}" created`);
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.disconnect();
        this._onConnectionChanged.dispose();
    }
}

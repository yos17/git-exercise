import * as vscode from 'vscode';
import { SASConnectionManager } from '../connection/connectionManager';
import { SASLogOutputChannel } from '../utils/logChannel';

/**
 * Factory for creating SAS debug adapter instances
 */
export class SASDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    private connectionManager: SASConnectionManager;
    private logChannel: SASLogOutputChannel;

    constructor(connectionManager: SASConnectionManager, logChannel: SASLogOutputChannel) {
        this.connectionManager = connectionManager;
        this.logChannel = logChannel;
    }

    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // Use the debug adapter as an executable
        // The adapter is bundled separately by webpack
        return new vscode.DebugAdapterExecutable('node', [
            `${__dirname}/debugAdapter.js`
        ]);
    }

    dispose() {
        // Cleanup if needed
    }
}

/**
 * Inline debug adapter implementation (alternative approach)
 * Can be used for tighter integration with the extension
 */
export class SASInlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    private connectionManager: SASConnectionManager;
    private logChannel: SASLogOutputChannel;

    constructor(connectionManager: SASConnectionManager, logChannel: SASLogOutputChannel) {
        this.connectionManager = connectionManager;
        this.logChannel = logChannel;
    }

    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // For inline implementation, we would create a DebugAdapterInlineImplementation
        // This requires the debug adapter to implement vscode.DebugAdapter interface
        // For now, use the executable approach
        return new vscode.DebugAdapterExecutable('node', [
            `${__dirname}/debugAdapter.js`
        ]);
    }

    dispose() {
        // Cleanup if needed
    }
}

import * as vscode from 'vscode';
import { SASConnectionManager } from '../connection/connectionManager';

interface MacroVarItem {
    name: string;
    value: string;
    scope: 'global' | 'local' | 'automatic';
}

export class MacroVarsProvider implements vscode.TreeDataProvider<MacroVarItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MacroVarItem | undefined | null | void> =
        new vscode.EventEmitter<MacroVarItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MacroVarItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private connection: SASConnectionManager;
    private variables: MacroVarItem[] = [];

    constructor(connection: SASConnectionManager) {
        this.connection = connection;

        connection.onConnectionChange((connected) => {
            if (connected) {
                this.refresh();
            } else {
                this.variables = [];
                this._onDidChangeTreeData.fire();
            }
        });
    }

    async refresh(): Promise<void> {
        if (!this.connection.isConnected()) {
            this.variables = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const vars = await this.connection.getMacroVariables();
            this.variables = vars.map(v => ({
                name: v.name,
                value: v.value,
                scope: v.scope as 'global' | 'local' | 'automatic'
            }));
        } catch (error) {
            this.variables = [];
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: MacroVarItem): vscode.TreeItem {
        const item = new vscode.TreeItem(`&${element.name}`);

        item.description = element.value.length > 50
            ? element.value.substring(0, 50) + '...'
            : element.value;

        item.tooltip = new vscode.MarkdownString();
        item.tooltip.appendCodeblock(`&${element.name} = ${element.value}`, 'sas');
        item.tooltip.appendMarkdown(`\n\n**Scope:** ${element.scope}`);

        item.contextValue = 'macroVar';

        // Icon based on scope
        switch (element.scope) {
            case 'global':
                item.iconPath = new vscode.ThemeIcon('globe');
                break;
            case 'local':
                item.iconPath = new vscode.ThemeIcon('symbol-variable');
                break;
            case 'automatic':
                item.iconPath = new vscode.ThemeIcon('symbol-constant');
                break;
        }

        return item;
    }

    getChildren(element?: MacroVarItem): MacroVarItem[] {
        if (element) {
            return [];
        }

        if (!this.connection.isConnected()) {
            return [];
        }

        // Group by scope
        const sorted = [...this.variables].sort((a, b) => {
            // Sort by scope first (automatic, global, local), then by name
            const scopeOrder = { automatic: 0, global: 1, local: 2 };
            const scopeDiff = scopeOrder[a.scope] - scopeOrder[b.scope];
            if (scopeDiff !== 0) return scopeDiff;
            return a.name.localeCompare(b.name);
        });

        return sorted;
    }
}

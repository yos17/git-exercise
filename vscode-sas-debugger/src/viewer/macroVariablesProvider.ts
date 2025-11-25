import * as vscode from 'vscode';
import { SASConnectionManager } from '../connection/connectionManager';

/**
 * Tree item for macro variables
 */
export class MacroVariableItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly value: string,
        public readonly scope: 'global' | 'local' | 'automatic',
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(name, collapsibleState);

        this.description = value.length > 50 ? value.substring(0, 50) + '...' : value;
        this.tooltip = `&${name} = ${value}\nScope: ${scope}`;

        // Set icon based on scope
        switch (scope) {
            case 'global':
                this.iconPath = new vscode.ThemeIcon('globe');
                break;
            case 'local':
                this.iconPath = new vscode.ThemeIcon('symbol-variable');
                break;
            case 'automatic':
                this.iconPath = new vscode.ThemeIcon('symbol-constant');
                break;
        }

        this.contextValue = 'macroVariable';
    }
}

/**
 * Category item for grouping macro variables
 */
export class MacroVariableCategoryItem extends vscode.TreeItem {
    constructor(
        public readonly category: 'global' | 'local' | 'automatic',
        public readonly count: number
    ) {
        super(
            category.charAt(0).toUpperCase() + category.slice(1) + ' Variables',
            vscode.TreeItemCollapsibleState.Expanded
        );

        this.description = `(${count})`;
        this.contextValue = 'macroCategory';

        switch (category) {
            case 'global':
                this.iconPath = new vscode.ThemeIcon('globe');
                break;
            case 'local':
                this.iconPath = new vscode.ThemeIcon('symbol-variable');
                break;
            case 'automatic':
                this.iconPath = new vscode.ThemeIcon('symbol-constant');
                break;
        }
    }
}

type MacroTreeItem = MacroVariableItem | MacroVariableCategoryItem;

/**
 * Provides tree data for macro variables
 */
export class MacroVariablesProvider implements vscode.TreeDataProvider<MacroTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MacroTreeItem | undefined | null | void> =
        new vscode.EventEmitter<MacroTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MacroTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private connectionManager: SASConnectionManager;

    private globalVars: Map<string, string> = new Map();
    private localVars: Map<string, string> = new Map();
    private automaticVars: Map<string, string> = new Map();

    constructor(connectionManager: SASConnectionManager) {
        this.connectionManager = connectionManager;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Update variables from debug session
     */
    updateVariables(
        global: Map<string, string>,
        local: Map<string, string>,
        automatic?: Map<string, string>
    ): void {
        this.globalVars = global;
        this.localVars = local;
        if (automatic) {
            this.automaticVars = automatic;
        }
        this.refresh();
    }

    getTreeItem(element: MacroTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: MacroTreeItem): Promise<MacroTreeItem[]> {
        if (!element) {
            // Root level - show categories
            const items: MacroTreeItem[] = [];

            if (this.automaticVars.size > 0) {
                items.push(new MacroVariableCategoryItem('automatic', this.automaticVars.size));
            }

            if (this.globalVars.size > 0) {
                items.push(new MacroVariableCategoryItem('global', this.globalVars.size));
            }

            if (this.localVars.size > 0) {
                items.push(new MacroVariableCategoryItem('local', this.localVars.size));
            }

            if (items.length === 0) {
                return [
                    new MacroVariableItem(
                        'No macro variables',
                        'Start debugging to see macro variables',
                        'global'
                    )
                ];
            }

            return items;
        }

        if (element instanceof MacroVariableCategoryItem) {
            let vars: Map<string, string>;

            switch (element.category) {
                case 'global':
                    vars = this.globalVars;
                    break;
                case 'local':
                    vars = this.localVars;
                    break;
                case 'automatic':
                    vars = this.automaticVars;
                    break;
                default:
                    vars = new Map();
            }

            return Array.from(vars.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, value]) => new MacroVariableItem(name, value, element.category));
        }

        return [];
    }
}

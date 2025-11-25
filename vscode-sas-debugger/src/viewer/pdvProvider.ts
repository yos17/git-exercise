import * as vscode from 'vscode';

/**
 * Tree item for PDV (Program Data Vector) variables
 */
export class PDVVariableItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly value: string,
        public readonly varType: 'numeric' | 'character' | 'automatic',
        public readonly length?: number,
        public readonly format?: string
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);

        this.description = value;
        this.tooltip = this.buildTooltip();

        // Set icon based on type
        switch (varType) {
            case 'numeric':
                this.iconPath = new vscode.ThemeIcon('symbol-number');
                break;
            case 'character':
                this.iconPath = new vscode.ThemeIcon('symbol-string');
                break;
            case 'automatic':
                this.iconPath = new vscode.ThemeIcon('symbol-constant');
                break;
        }

        this.contextValue = 'pdvVariable';
    }

    private buildTooltip(): string {
        let tip = `${this.name} = ${this.value}\nType: ${this.varType}`;
        if (this.length) {
            tip += `\nLength: ${this.length}`;
        }
        if (this.format) {
            tip += `\nFormat: ${this.format}`;
        }
        return tip;
    }
}

/**
 * Category item for PDV variable groups
 */
export class PDVCategoryItem extends vscode.TreeItem {
    constructor(
        public readonly category: 'data' | 'automatic',
        public readonly count: number
    ) {
        super(
            category === 'data' ? 'Data Variables' : 'Automatic Variables',
            vscode.TreeItemCollapsibleState.Expanded
        );

        this.description = `(${count})`;
        this.contextValue = 'pdvCategory';

        this.iconPath = category === 'data'
            ? new vscode.ThemeIcon('symbol-variable')
            : new vscode.ThemeIcon('symbol-constant');
    }
}

type PDVTreeItem = PDVVariableItem | PDVCategoryItem;

interface PDVVariable {
    name: string;
    value: string;
    type: 'numeric' | 'character';
    length?: number;
    format?: string;
}

/**
 * Provides tree data for PDV (Program Data Vector) during DATA step debugging
 */
export class PDVProvider implements vscode.TreeDataProvider<PDVTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<PDVTreeItem | undefined | null | void> =
        new vscode.EventEmitter<PDVTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PDVTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private dataVariables: PDVVariable[] = [];
    private automaticVariables: PDVVariable[] = [];
    private currentObservation: number = 0;

    constructor() {
        // Initialize with default automatic variables
        this.automaticVariables = [
            { name: '_N_', value: '1', type: 'numeric' },
            { name: '_ERROR_', value: '0', type: 'numeric' },
            { name: '_IORC_', value: '0', type: 'numeric' }
        ];
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Update PDV from debug session
     */
    updatePDV(variables: PDVVariable[], observation: number): void {
        // Separate automatic variables from data variables
        this.dataVariables = variables.filter(v =>
            !['_N_', '_ERROR_', '_IORC_', '_NUMERIC_', '_CHARACTER_', '_ALL_'].includes(v.name.toUpperCase())
        );

        // Update automatic variables
        const autoVarNames = ['_N_', '_ERROR_', '_IORC_'];
        for (const name of autoVarNames) {
            const v = variables.find(v => v.name.toUpperCase() === name);
            if (v) {
                const existing = this.automaticVariables.find(av => av.name === name);
                if (existing) {
                    existing.value = v.value;
                }
            }
        }

        this.currentObservation = observation;
        this.refresh();
    }

    /**
     * Clear PDV (when not in DATA step)
     */
    clear(): void {
        this.dataVariables = [];
        this.automaticVariables = [
            { name: '_N_', value: '1', type: 'numeric' },
            { name: '_ERROR_', value: '0', type: 'numeric' },
            { name: '_IORC_', value: '0', type: 'numeric' }
        ];
        this.currentObservation = 0;
        this.refresh();
    }

    getTreeItem(element: PDVTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PDVTreeItem): Promise<PDVTreeItem[]> {
        if (!element) {
            // Root level - show categories
            const items: PDVTreeItem[] = [];

            if (this.automaticVariables.length > 0) {
                items.push(new PDVCategoryItem('automatic', this.automaticVariables.length));
            }

            if (this.dataVariables.length > 0) {
                items.push(new PDVCategoryItem('data', this.dataVariables.length));
            }

            if (items.length === 0) {
                return [
                    new PDVVariableItem(
                        'Not in DATA step',
                        'Start DATA step debugging to see PDV',
                        'automatic'
                    )
                ];
            }

            return items;
        }

        if (element instanceof PDVCategoryItem) {
            const vars = element.category === 'automatic'
                ? this.automaticVariables
                : this.dataVariables;

            return vars.map(v =>
                new PDVVariableItem(
                    v.name,
                    this.formatValue(v),
                    element.category === 'automatic' ? 'automatic' : v.type,
                    v.length,
                    v.format
                )
            );
        }

        return [];
    }

    /**
     * Format variable value for display
     */
    private formatValue(variable: PDVVariable): string {
        const value = variable.value;

        // Handle missing values
        if (value === '.' || value === '' || value === null || value === undefined) {
            return '.';
        }

        // Apply format if available
        if (variable.format && variable.type === 'numeric') {
            return this.applyFormat(parseFloat(value), variable.format);
        }

        // Truncate long strings
        if (variable.type === 'character' && value.length > 40) {
            return value.substring(0, 40) + '...';
        }

        return value;
    }

    /**
     * Apply SAS format to numeric value
     */
    private applyFormat(value: number, format: string): string {
        // Basic format handling
        const dateFormats = ['DATE', 'DATETIME', 'TIME', 'MMDDYY', 'DDMMYY', 'YYMMDD'];
        const upperFormat = format.toUpperCase();

        if (dateFormats.some(f => upperFormat.includes(f))) {
            // SAS dates are days since Jan 1, 1960
            const sasEpoch = new Date(1960, 0, 1);
            const date = new Date(sasEpoch.getTime() + value * 24 * 60 * 60 * 1000);
            return date.toLocaleDateString();
        }

        // Numeric formats
        const match = format.match(/(\d+)\.(\d+)/);
        if (match) {
            const decimals = parseInt(match[2]);
            return value.toFixed(decimals);
        }

        return value.toString();
    }
}

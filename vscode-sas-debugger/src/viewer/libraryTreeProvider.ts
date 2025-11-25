import * as vscode from 'vscode';
import { SASConnectionManager } from '../connection/connectionManager';
import { SASLibrary, SASDataset } from '../connection/sasConnection';

/**
 * Tree item representing a library or dataset
 */
export class LibraryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'library' | 'dataset',
        public readonly library?: string,
        public readonly dataset?: SASDataset
    ) {
        super(label, collapsibleState);

        if (itemType === 'library') {
            this.contextValue = 'library';
            this.iconPath = new vscode.ThemeIcon('database');
            this.tooltip = `Library: ${label}`;
        } else {
            this.contextValue = 'dataset';
            this.iconPath = new vscode.ThemeIcon('table');
            this.tooltip = dataset
                ? `${label}\nObservations: ${dataset.nobs}\nVariables: ${dataset.nvars}\n${dataset.label || ''}`
                : label;
            this.description = dataset ? `(${dataset.nobs} obs)` : '';
            this.command = {
                command: 'sasDebugger.openDatasetFromTree',
                title: 'Open Dataset',
                arguments: [{ libname: library, dataset: label }]
            };
        }
    }
}

/**
 * Provides tree data for SAS libraries and datasets
 */
export class LibraryTreeProvider implements vscode.TreeDataProvider<LibraryTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<LibraryTreeItem | undefined | null | void> =
        new vscode.EventEmitter<LibraryTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<LibraryTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private connectionManager: SASConnectionManager;
    private libraryCache: Map<string, SASDataset[]> = new Map();

    constructor(connectionManager: SASConnectionManager) {
        this.connectionManager = connectionManager;

        // Refresh when connection changes
        connectionManager.onConnectionChanged(() => {
            this.libraryCache.clear();
            this.refresh();
        });
    }

    refresh(): void {
        this.libraryCache.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: LibraryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: LibraryTreeItem): Promise<LibraryTreeItem[]> {
        if (!this.connectionManager.isConnected) {
            return [
                new LibraryTreeItem(
                    'Not connected - Click to connect',
                    vscode.TreeItemCollapsibleState.None,
                    'library'
                )
            ];
        }

        if (!element) {
            // Root level - show libraries
            try {
                const libraries = await this.connectionManager.getLibraries();
                return libraries.map(lib =>
                    new LibraryTreeItem(
                        lib.name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'library'
                    )
                );
            } catch (error) {
                return [
                    new LibraryTreeItem(
                        `Error: ${error}`,
                        vscode.TreeItemCollapsibleState.None,
                        'library'
                    )
                ];
            }
        } else if (element.itemType === 'library') {
            // Show datasets in library
            try {
                let datasets = this.libraryCache.get(element.label);
                if (!datasets) {
                    datasets = await this.connectionManager.getDatasets(element.label);
                    this.libraryCache.set(element.label, datasets);
                }

                return datasets.map(ds =>
                    new LibraryTreeItem(
                        ds.name,
                        vscode.TreeItemCollapsibleState.None,
                        'dataset',
                        element.label,
                        ds
                    )
                );
            } catch (error) {
                return [
                    new LibraryTreeItem(
                        `Error: ${error}`,
                        vscode.TreeItemCollapsibleState.None,
                        'dataset',
                        element.label
                    )
                ];
            }
        }

        return [];
    }
}

import * as vscode from 'vscode';
import { SASConnectionManager, LibraryInfo, DatasetInfo } from '../connection/connectionManager';

type TreeItemType = 'library' | 'dataset' | 'column';

interface TreeItemData {
    type: TreeItemType;
    name: string;
    libref?: string;
    dataset?: string;
    columnType?: string;
}

export class LibraryTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItemData | undefined | null | void> =
        new vscode.EventEmitter<TreeItemData | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItemData | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private connection: SASConnectionManager;
    private libraryCache: Map<string, LibraryInfo> = new Map();
    private datasetCache: Map<string, DatasetInfo[]> = new Map();

    constructor(connection: SASConnectionManager) {
        this.connection = connection;

        // Refresh when connection changes
        connection.onConnectionChange((connected) => {
            if (connected) {
                this.refresh();
            } else {
                this.libraryCache.clear();
                this.datasetCache.clear();
                this.refresh();
            }
        });
    }

    refresh(): void {
        this.libraryCache.clear();
        this.datasetCache.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        const item = new vscode.TreeItem(element.name);

        switch (element.type) {
            case 'library':
                item.iconPath = new vscode.ThemeIcon('database');
                item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                item.contextValue = 'library';
                item.tooltip = `Library: ${element.name}`;
                break;

            case 'dataset':
                item.iconPath = new vscode.ThemeIcon('table');
                item.collapsibleState = vscode.TreeItemCollapsibleState.None;
                item.contextValue = 'dataset';
                item.tooltip = `Dataset: ${element.libref}.${element.name}`;
                item.command = {
                    command: 'sasStudioAI.viewDataset',
                    title: 'View Dataset',
                    arguments: [{ libref: element.libref, dataset: element.name }]
                };
                break;

            case 'column':
                item.iconPath = new vscode.ThemeIcon(
                    element.columnType === 'num' ? 'symbol-number' : 'symbol-string'
                );
                item.collapsibleState = vscode.TreeItemCollapsibleState.None;
                item.contextValue = 'column';
                item.description = element.columnType;
                break;
        }

        return item;
    }

    async getChildren(element?: TreeItemData): Promise<TreeItemData[]> {
        if (!this.connection.isConnected()) {
            return [{
                type: 'library',
                name: '(Not connected - click to connect)'
            }];
        }

        if (!element) {
            // Root level - return libraries
            try {
                const libraries = await this.connection.getLibraries();

                return libraries.map(lib => ({
                    type: 'library' as TreeItemType,
                    name: lib.name
                }));
            } catch (error) {
                return [{
                    type: 'library',
                    name: `Error: ${error}`
                }];
            }
        }

        if (element.type === 'library') {
            // Library level - return datasets
            try {
                const datasets = await this.connection.getDatasets(element.name);

                return datasets.map(ds => ({
                    type: 'dataset' as TreeItemType,
                    name: ds.name,
                    libref: element.name,
                    dataset: ds.name
                }));
            } catch (error) {
                return [{
                    type: 'dataset',
                    name: `Error: ${error}`,
                    libref: element.name
                }];
            }
        }

        return [];
    }
}

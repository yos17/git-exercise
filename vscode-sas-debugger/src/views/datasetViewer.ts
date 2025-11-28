import * as vscode from 'vscode';
import { SASConnectionManager } from '../connection/connectionManager';

export class DatasetViewerPanel {
    public static currentPanel: DatasetViewerPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly connection: SASConnectionManager;
    private readonly libref: string;
    private readonly dataset: string;

    private currentPage: number = 0;
    private pageSize: number = 100;
    private filter: string = '';
    private sortColumn: string = '';
    private sortDirection: 'asc' | 'desc' = 'asc';
    private totalRows: number = 0;
    private columns: any[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        connection: SASConnectionManager,
        libref: string,
        dataset: string
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.connection = connection;
        this.libref = libref;
        this.dataset = dataset;

        this.panel.webview.html = this.getLoadingHtml();

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'loadPage':
                        this.currentPage = message.page;
                        await this.loadData();
                        break;
                    case 'setPageSize':
                        this.pageSize = message.pageSize;
                        this.currentPage = 0;
                        await this.loadData();
                        break;
                    case 'setFilter':
                        this.filter = message.filter;
                        this.currentPage = 0;
                        await this.loadData();
                        break;
                    case 'sort':
                        if (this.sortColumn === message.column) {
                            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                        } else {
                            this.sortColumn = message.column;
                            this.sortDirection = 'asc';
                        }
                        await this.loadData();
                        break;
                    case 'export':
                        await this.exportData(message.format);
                        break;
                    case 'anonymize':
                        await vscode.commands.executeCommand('sasStudioAI.anonymizeDataset', {
                            libref: this.libref,
                            dataset: this.dataset
                        });
                        break;
                    case 'refresh':
                        await this.loadData();
                        break;
                }
            }
        );

        this.panel.onDidDispose(() => {
            DatasetViewerPanel.currentPanel = undefined;
        });

        this.loadData();
    }

    public static async show(
        extensionUri: vscode.Uri,
        connection: SASConnectionManager,
        libref: string,
        dataset: string
    ): Promise<void> {
        const column = vscode.ViewColumn.Beside;

        if (DatasetViewerPanel.currentPanel) {
            DatasetViewerPanel.currentPanel.panel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'sasDatasetViewer',
            `${libref}.${dataset}`,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        DatasetViewerPanel.currentPanel = new DatasetViewerPanel(
            panel,
            extensionUri,
            connection,
            libref,
            dataset
        );
    }

    private async loadData(): Promise<void> {
        try {
            const start = this.currentPage * this.pageSize;

            const result = await this.connection.getDatasetData(
                this.libref,
                this.dataset,
                {
                    start,
                    limit: this.pageSize,
                    filter: this.buildWhereClause()
                }
            );

            this.columns = result.columns;
            this.totalRows = result.totalRows;

            this.panel.webview.html = this.getHtml(result.columns, result.data, result.totalRows);
        } catch (error) {
            this.panel.webview.html = this.getErrorHtml(`Failed to load data: ${error}`);
        }
    }

    private buildWhereClause(): string {
        let where = '';

        if (this.filter) {
            // Parse filter into WHERE clause
            // Support: column = value, column > value, column CONTAINS 'text'
            where = this.filter;
        }

        if (this.sortColumn) {
            const order = `ORDER BY ${this.sortColumn} ${this.sortDirection.toUpperCase()}`;
            return where ? `${where} ${order}` : order;
        }

        return where;
    }

    private async exportData(format: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${this.dataset}.${format}`),
            filters: {
                [format.toUpperCase()]: [format]
            }
        });

        if (!uri) return;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Exporting ${this.libref}.${this.dataset}...`
            },
            async () => {
                const sasCode = `
proc export data=${this.libref}.${this.dataset}
    outfile="${uri.fsPath}"
    dbms=${format} replace;
run;
`;
                await this.connection.submit(sasCode);
                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            }
        );
    }

    private getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .loader {
            border: 4px solid var(--vscode-input-border);
            border-top: 4px solid var(--vscode-button-background);
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="loader"></div>
</body>
</html>`;
    }

    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            padding: 20px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-errorForeground);
            background: var(--vscode-editor-background);
        }
    </style>
</head>
<body>
    <h2>Error</h2>
    <p>${message}</p>
</body>
</html>`;
    }

    private getHtml(columns: any[], data: any[][], totalRows: number): string {
        const totalPages = Math.ceil(totalRows / this.pageSize);

        const columnHeaders = columns.map((col, i) => `
            <th onclick="sort('${col.name}')" class="${this.sortColumn === col.name ? 'sorted' : ''}">
                ${col.name}
                ${this.sortColumn === col.name ? (this.sortDirection === 'asc' ? '▲' : '▼') : ''}
                <span class="type">${col.type}</span>
            </th>
        `).join('');

        const rows = data.map((row, rowIndex) => `
            <tr>
                <td class="row-num">${this.currentPage * this.pageSize + rowIndex + 1}</td>
                ${row.map((cell, colIndex) => `
                    <td class="${columns[colIndex]?.type === 'num' ? 'num' : 'char'}">${
                        cell === null ? '<span class="null">NULL</span>' : this.escapeHtml(String(cell))
                    }</td>
                `).join('')}
            </tr>
        `).join('');

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .toolbar {
            position: sticky;
            top: 0;
            z-index: 100;
            background: var(--vscode-sideBar-background);
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
        }
        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .toolbar label {
            color: var(--vscode-descriptionForeground);
        }
        input, select, button {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 5px 10px;
            border-radius: 3px;
            font-size: 12px;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .filter-input {
            width: 300px;
        }
        .stats {
            margin-left: auto;
            color: var(--vscode-descriptionForeground);
        }
        .table-container {
            overflow: auto;
            max-height: calc(100vh - 120px);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        th {
            position: sticky;
            top: 0;
            background: var(--vscode-editor-background);
            border-bottom: 2px solid var(--vscode-panel-border);
            padding: 8px 12px;
            text-align: left;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }
        th:hover {
            background: var(--vscode-list-hoverBackground);
        }
        th.sorted {
            color: var(--vscode-textLink-foreground);
        }
        th .type {
            display: block;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            font-weight: normal;
        }
        td {
            padding: 6px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        td.row-num {
            color: var(--vscode-editorLineNumber-foreground);
            width: 50px;
            text-align: right;
            background: var(--vscode-editor-lineHighlightBackground);
        }
        td.num {
            text-align: right;
            font-family: var(--vscode-editor-font-family);
        }
        td .null {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        tr:hover td {
            background: var(--vscode-list-hoverBackground);
        }
        .pagination {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            position: sticky;
            bottom: 0;
        }
        .page-info {
            color: var(--vscode-descriptionForeground);
        }
        .security-badge {
            background: #f0ad4e;
            color: #000;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="toolbar-group">
            <input type="text" class="filter-input" placeholder="Filter: column = value, column > 100, etc."
                   value="${this.escapeHtml(this.filter)}" onchange="setFilter(this.value)">
            <button onclick="applyFilter()">Apply</button>
            <button class="secondary" onclick="clearFilter()">Clear</button>
        </div>
        <div class="toolbar-group">
            <label>Page Size:</label>
            <select onchange="setPageSize(this.value)">
                <option value="50" ${this.pageSize === 50 ? 'selected' : ''}>50</option>
                <option value="100" ${this.pageSize === 100 ? 'selected' : ''}>100</option>
                <option value="500" ${this.pageSize === 500 ? 'selected' : ''}>500</option>
                <option value="1000" ${this.pageSize === 1000 ? 'selected' : ''}>1000</option>
            </select>
        </div>
        <div class="toolbar-group">
            <button onclick="exportData('csv')">Export CSV</button>
            <button onclick="exportData('xlsx')">Export Excel</button>
            <button class="secondary" onclick="anonymize()">
                <span class="security-badge">SECURE</span> Anonymize & Export
            </button>
        </div>
        <div class="stats">
            ${totalRows.toLocaleString()} rows | ${columns.length} columns
        </div>
    </div>

    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    ${columnHeaders}
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    </div>

    <div class="pagination">
        <button onclick="loadPage(0)" ${this.currentPage === 0 ? 'disabled' : ''}>First</button>
        <button onclick="loadPage(${this.currentPage - 1})" ${this.currentPage === 0 ? 'disabled' : ''}>Previous</button>
        <span class="page-info">Page ${this.currentPage + 1} of ${totalPages}</span>
        <button onclick="loadPage(${this.currentPage + 1})" ${this.currentPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
        <button onclick="loadPage(${totalPages - 1})" ${this.currentPage >= totalPages - 1 ? 'disabled' : ''}>Last</button>
        <button onclick="refresh()" style="margin-left: auto;">Refresh</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function loadPage(page) {
            vscode.postMessage({ command: 'loadPage', page: page });
        }

        function setPageSize(size) {
            vscode.postMessage({ command: 'setPageSize', pageSize: parseInt(size) });
        }

        function setFilter(filter) {
            document.querySelector('.filter-input').value = filter;
        }

        function applyFilter() {
            const filter = document.querySelector('.filter-input').value;
            vscode.postMessage({ command: 'setFilter', filter: filter });
        }

        function clearFilter() {
            document.querySelector('.filter-input').value = '';
            vscode.postMessage({ command: 'setFilter', filter: '' });
        }

        function sort(column) {
            vscode.postMessage({ command: 'sort', column: column });
        }

        function exportData(format) {
            vscode.postMessage({ command: 'export', format: format });
        }

        function anonymize() {
            vscode.postMessage({ command: 'anonymize' });
        }

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        // Enter key on filter input
        document.querySelector('.filter-input').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                applyFilter();
            }
        });
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

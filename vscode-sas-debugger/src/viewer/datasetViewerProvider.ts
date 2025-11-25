import * as vscode from 'vscode';
import { SASConnectionManager } from '../connection/connectionManager';
import { SASVariable } from '../connection/sasConnection';
import * as path from 'path';

/**
 * Provides dataset viewing functionality via webview
 */
export class DatasetViewerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'sasDatasetViewer';

    private _view?: vscode.WebviewView;
    private connectionManager: SASConnectionManager;
    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri, connectionManager: SASConnectionManager) {
        this.extensionUri = extensionUri;
        this.connectionManager = connectionManager;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media'),
                vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')
            ]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'loadData':
                    await this.loadData(message.library, message.dataset, message.options);
                    break;
                case 'filter':
                    await this.filterData(message.library, message.dataset, message.where);
                    break;
                case 'export':
                    await this.exportData(message.format, message.data);
                    break;
            }
        });
    }

    /**
     * Open a dataset for viewing
     */
    async openDataset(datasetPath: string): Promise<void> {
        // Parse the path - could be library.dataset or file path
        let library: string;
        let dataset: string;

        if (datasetPath.includes('.sas7bdat')) {
            // Local file - use pyreadstat
            await this.openLocalDataset(datasetPath);
            return;
        }

        const parts = datasetPath.split('.');
        if (parts.length === 2) {
            library = parts[0];
            dataset = parts[1];
        } else {
            library = 'WORK';
            dataset = datasetPath;
        }

        // Create a new webview panel for the dataset
        const panel = vscode.window.createWebviewPanel(
            'sasDataset',
            `${library}.${dataset}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'media'),
                    vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')
                ]
            }
        );

        panel.webview.html = this.getDatasetPanelHtml(panel.webview, library, dataset);

        // Handle messages
        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'getData':
                    const data = await this.connectionManager.getData(
                        message.library,
                        message.dataset,
                        message.options
                    );
                    panel.webview.postMessage({
                        command: 'dataLoaded',
                        columns: data.columns,
                        rows: data.rows
                    });
                    break;
                case 'getVariables':
                    const vars = await this.connectionManager.getVariables(
                        message.library,
                        message.dataset
                    );
                    panel.webview.postMessage({
                        command: 'variablesLoaded',
                        variables: vars
                    });
                    break;
            }
        });

        // Load initial data
        try {
            const vars = await this.connectionManager.getVariables(library, dataset);
            const data = await this.connectionManager.getData(library, dataset, { obs: 1000 });

            panel.webview.postMessage({
                command: 'initialize',
                library,
                dataset,
                variables: vars,
                columns: data.columns,
                rows: data.rows
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load dataset: ${error}`);
        }
    }

    /**
     * Open a local SAS7BDAT file
     */
    private async openLocalDataset(filePath: string): Promise<void> {
        // Use Python with pyreadstat to read local file
        const panel = vscode.window.createWebviewPanel(
            'sasDataset',
            path.basename(filePath),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'media'),
                    vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')
                ]
            }
        );

        panel.webview.html = this.getLocalDatasetPanelHtml(panel.webview, filePath);

        // The webview will handle loading via Python bridge
    }

    /**
     * Load data into webview
     */
    private async loadData(
        library: string,
        dataset: string,
        options?: { firstObs?: number; obs?: number; where?: string }
    ): Promise<void> {
        if (!this._view) return;

        try {
            const data = await this.connectionManager.getData(library, dataset, options);
            this._view.webview.postMessage({
                command: 'dataLoaded',
                columns: data.columns,
                rows: data.rows
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load data: ${error}`);
        }
    }

    /**
     * Filter data with WHERE clause
     */
    private async filterData(library: string, dataset: string, where: string): Promise<void> {
        await this.loadData(library, dataset, { where });
    }

    /**
     * Export data to file
     */
    private async exportData(format: 'csv' | 'xlsx' | 'json', data: any[][]): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            filters: {
                'CSV files': ['csv'],
                'Excel files': ['xlsx'],
                'JSON files': ['json']
            }
        });

        if (!uri) return;

        const fs = await import('fs');

        if (format === 'csv') {
            const csv = data.map(row => row.map(cell =>
                typeof cell === 'string' && cell.includes(',') ? `"${cell}"` : cell
            ).join(',')).join('\n');
            fs.writeFileSync(uri.fsPath, csv);
        } else if (format === 'json') {
            fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2));
        }

        vscode.window.showInformationMessage(`Data exported to ${uri.fsPath}`);
    }

    /**
     * Get HTML for embedded webview
     */
    private getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SAS Dataset Viewer</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 10px;
        }
        .placeholder {
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: 20px;
        }
    </style>
</head>
<body>
    <div class="placeholder">
        <p>Use "SAS: View Dataset" command or double-click a dataset in the library browser to view data.</p>
    </div>
</body>
</html>`;
    }

    /**
     * Get HTML for dataset panel
     */
    private getDatasetPanelHtml(webview: vscode.Webview, library: string, dataset: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <title>${library}.${dataset}</title>
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 10px;
        }
        .toolbar {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            padding: 10px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
        }
        .toolbar input {
            flex: 1;
            padding: 5px 10px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }
        .toolbar button {
            padding: 5px 15px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .info {
            margin-bottom: 10px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .table-container {
            overflow: auto;
            max-height: calc(100vh - 150px);
            border: 1px solid var(--vscode-panel-border);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        th, td {
            padding: 6px 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
            white-space: nowrap;
        }
        th {
            background: var(--vscode-editor-inactiveSelectionBackground);
            position: sticky;
            top: 0;
            cursor: pointer;
        }
        th:hover {
            background: var(--vscode-list-hoverBackground);
        }
        tr:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .numeric {
            text-align: right;
            font-family: monospace;
        }
        .missing {
            color: var(--vscode-editorWarning-foreground);
            font-style: italic;
        }
        .loading {
            text-align: center;
            padding: 50px;
        }
        .column-header {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .sort-indicator {
            font-size: 10px;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <input type="text" id="whereClause" placeholder="WHERE clause (e.g., age > 30 and sex = 'F')">
        <button onclick="applyFilter()">Filter</button>
        <button onclick="clearFilter()">Clear</button>
        <button onclick="exportCSV()">Export CSV</button>
    </div>
    <div class="info" id="info">Loading...</div>
    <div class="table-container" id="tableContainer">
        <div class="loading">Loading data...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentData = { columns: [], rows: [] };
        let sortColumn = null;
        let sortAsc = true;
        const library = '${library}';
        const dataset = '${dataset}';

        // Request initial data
        vscode.postMessage({
            command: 'getData',
            library: library,
            dataset: dataset,
            options: { obs: 1000 }
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'initialize':
                case 'dataLoaded':
                    currentData = {
                        columns: message.columns || message.variables || [],
                        rows: message.rows || []
                    };
                    renderTable();
                    break;
            }
        });

        function renderTable() {
            const container = document.getElementById('tableContainer');
            const info = document.getElementById('info');

            if (currentData.rows.length === 0) {
                container.innerHTML = '<div class="loading">No data to display</div>';
                info.textContent = 'No observations';
                return;
            }

            info.textContent = \`Showing \${currentData.rows.length} observations, \${currentData.columns.length} variables\`;

            let html = '<table><thead><tr>';

            // Headers
            currentData.columns.forEach((col, idx) => {
                const sortIndicator = sortColumn === idx
                    ? (sortAsc ? ' ▲' : ' ▼')
                    : '';
                html += \`<th onclick="sortBy(\${idx})">
                    <div class="column-header">
                        <span>\${col.name}</span>
                        <span class="sort-indicator">\${sortIndicator}</span>
                    </div>
                    <div style="font-size:10px;font-weight:normal;">\${col.type} (\${col.length})</div>
                </th>\`;
            });
            html += '</tr></thead><tbody>';

            // Rows
            currentData.rows.forEach(row => {
                html += '<tr>';
                row.forEach((cell, idx) => {
                    const col = currentData.columns[idx];
                    const isNumeric = col && col.type === 'numeric';
                    const isMissing = cell === null || cell === '' || cell === '.';
                    const className = [
                        isNumeric ? 'numeric' : '',
                        isMissing ? 'missing' : ''
                    ].filter(Boolean).join(' ');
                    const displayValue = isMissing ? '.' : cell;
                    html += \`<td class="\${className}">\${displayValue}</td>\`;
                });
                html += '</tr>';
            });

            html += '</tbody></table>';
            container.innerHTML = html;
        }

        function sortBy(colIdx) {
            if (sortColumn === colIdx) {
                sortAsc = !sortAsc;
            } else {
                sortColumn = colIdx;
                sortAsc = true;
            }

            currentData.rows.sort((a, b) => {
                let valA = a[colIdx];
                let valB = b[colIdx];

                // Handle missing values
                if (valA === null || valA === '' || valA === '.') return sortAsc ? 1 : -1;
                if (valB === null || valB === '' || valB === '.') return sortAsc ? -1 : 1;

                // Numeric comparison
                const numA = parseFloat(valA);
                const numB = parseFloat(valB);
                if (!isNaN(numA) && !isNaN(numB)) {
                    return sortAsc ? numA - numB : numB - numA;
                }

                // String comparison
                return sortAsc
                    ? String(valA).localeCompare(String(valB))
                    : String(valB).localeCompare(String(valA));
            });

            renderTable();
        }

        function applyFilter() {
            const where = document.getElementById('whereClause').value;
            vscode.postMessage({
                command: 'getData',
                library: library,
                dataset: dataset,
                options: { obs: 1000, where: where }
            });
        }

        function clearFilter() {
            document.getElementById('whereClause').value = '';
            vscode.postMessage({
                command: 'getData',
                library: library,
                dataset: dataset,
                options: { obs: 1000 }
            });
        }

        function exportCSV() {
            if (currentData.rows.length === 0) return;

            const headers = currentData.columns.map(c => c.name).join(',');
            const rows = currentData.rows.map(row =>
                row.map(cell => {
                    if (cell === null || cell === '') return '';
                    if (typeof cell === 'string' && (cell.includes(',') || cell.includes('"'))) {
                        return '"' + cell.replace(/"/g, '""') + '"';
                    }
                    return cell;
                }).join(',')
            ).join('\\n');

            const csv = headers + '\\n' + rows;

            vscode.postMessage({
                command: 'export',
                format: 'csv',
                data: csv
            });
        }
    </script>
</body>
</html>`;
    }

    /**
     * Get HTML for local dataset panel
     */
    private getLocalDatasetPanelHtml(webview: vscode.Webview, filePath: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${path.basename(filePath)}</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
        }
    </style>
</head>
<body>
    <h2>Local Dataset: ${path.basename(filePath)}</h2>
    <p>Loading local SAS7BDAT file requires Python with pyreadstat...</p>
    <p>Path: ${filePath}</p>
</body>
</html>`;
    }
}

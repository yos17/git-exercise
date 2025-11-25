import * as vscode from 'vscode';

/**
 * Result from SAS code execution
 */
export interface SASExecutionResult {
    log: string;
    output: string;
    status: 'success' | 'error' | 'warning';
    errors: SASError[];
    warnings: string[];
}

/**
 * SAS error information
 */
export interface SASError {
    line: number;
    column?: number;
    message: string;
    code?: string;
}

/**
 * SAS library information
 */
export interface SASLibrary {
    name: string;
    path: string;
    engine: string;
    readonly: boolean;
}

/**
 * SAS dataset information
 */
export interface SASDataset {
    name: string;
    library: string;
    nobs: number;
    nvars: number;
    created: Date;
    modified: Date;
    label?: string;
}

/**
 * SAS variable metadata
 */
export interface SASVariable {
    name: string;
    type: 'numeric' | 'character';
    length: number;
    format?: string;
    informat?: string;
    label?: string;
}

/**
 * SAS OnDemand for Academics regions
 */
export type SODARegion = 'us1' | 'us2' | 'eu1' | 'eu2' | 'ap1';

/**
 * SODA region server mappings
 */
export const SODA_SERVERS: Record<SODARegion, string[]> = {
    'us1': ['odaws01-usw2.oda.sas.com', 'odaws02-usw2.oda.sas.com'],
    'us2': ['odaws01-use1.oda.sas.com', 'odaws02-use1.oda.sas.com'],
    'eu1': ['odaws01-euw1.oda.sas.com', 'odaws02-euw1.oda.sas.com'],
    'eu2': ['odaws01-euw2.oda.sas.com', 'odaws02-euw2.oda.sas.com'],
    'ap1': ['odaws01-apse1.oda.sas.com', 'odaws02-apse1.oda.sas.com']
};

/**
 * Connection profile configuration
 */
export interface ConnectionProfile {
    name: string;
    type: 'saspy' | 'iom' | 'viya' | 'oda';  // Added 'oda' for SAS OnDemand for Academics
    host?: string;
    port?: number;
    sasPath?: string;
    username?: string;
    authType?: 'password' | 'token' | 'integrated';
    // SODA-specific fields
    sodaRegion?: SODARegion;
    sodaUsername?: string;  // Your SODA email/username
}

/**
 * Abstract interface for SAS connections
 */
export interface SASConnection {
    readonly isConnected: boolean;
    readonly connectionType: string;

    connect(): Promise<void>;
    disconnect(): Promise<void>;

    submit(code: string): Promise<SASExecutionResult>;
    submitAsync(code: string): Promise<string>; // Returns job ID

    sendDebugCommand(command: string): Promise<string>;

    getLibraries(): Promise<SASLibrary[]>;
    getDatasets(library: string): Promise<SASDataset[]>;
    getVariables(library: string, dataset: string): Promise<SASVariable[]>;
    getData(
        library: string,
        dataset: string,
        options?: {
            where?: string;
            firstObs?: number;
            obs?: number;
            keep?: string[];
            drop?: string[];
        }
    ): Promise<{ columns: SASVariable[]; rows: any[][] }>;
}

/**
 * Factory for creating SAS connections
 */
export class SASConnectionFactory {
    static async create(profileName: string): Promise<SASConnection> {
        const config = vscode.workspace.getConfiguration('sasDebugger');
        const profiles = config.get<ConnectionProfile[]>('connectionProfiles') || [];
        const profile = profiles.find(p => p.name === profileName);

        if (!profile) {
            // Try to create a default local connection
            return new SASPyConnection({
                name: 'default',
                type: 'saspy'
            });
        }

        switch (profile.type) {
            case 'saspy':
                return new SASPyConnection(profile);
            case 'iom':
                return new IOMConnection(profile);
            case 'viya':
                return new ViyaConnection(profile);
            case 'oda':
                return new SODAConnection(profile);
            default:
                throw new Error(`Unknown connection type: ${profile.type}`);
        }
    }
}

/**
 * SASPy-based connection (uses Python subprocess)
 */
export class SASPyConnection implements SASConnection {
    private profile: ConnectionProfile;
    private _isConnected: boolean = false;
    private pythonProcess: any = null;

    constructor(profile: ConnectionProfile) {
        this.profile = profile;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    get connectionType(): string {
        return 'saspy';
    }

    async connect(): Promise<void> {
        const config = vscode.workspace.getConfiguration('sasDebugger');
        const pythonPath = config.get<string>('pythonPath') || 'python';

        // Start Python process with SASPy bridge
        const { spawn } = await import('child_process');
        const path = await import('path');

        const bridgePath = path.join(__dirname, '..', 'python', 'saspy_bridge.py');

        this.pythonProcess = spawn(pythonPath, [bridgePath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Send connection configuration
        const connectConfig = JSON.stringify({
            command: 'connect',
            config: {
                cfgname: this.profile.name,
                host: this.profile.host,
                port: this.profile.port,
                sasPath: this.profile.sasPath
            }
        });

        await this.sendCommand(connectConfig);
        this._isConnected = true;
    }

    async disconnect(): Promise<void> {
        if (this.pythonProcess) {
            await this.sendCommand(JSON.stringify({ command: 'disconnect' }));
            this.pythonProcess.kill();
            this.pythonProcess = null;
        }
        this._isConnected = false;
    }

    async submit(code: string): Promise<SASExecutionResult> {
        const response = await this.sendCommand(JSON.stringify({
            command: 'submit',
            code: code
        }));

        return this.parseResponse(response);
    }

    async submitAsync(code: string): Promise<string> {
        const response = await this.sendCommand(JSON.stringify({
            command: 'submit_async',
            code: code
        }));

        const result = JSON.parse(response);
        return result.jobId;
    }

    async sendDebugCommand(command: string): Promise<string> {
        const response = await this.sendCommand(JSON.stringify({
            command: 'debug',
            debugCommand: command
        }));

        const result = JSON.parse(response);
        return result.output || '';
    }

    async getLibraries(): Promise<SASLibrary[]> {
        const code = `
            proc sql noprint;
                select libname, path, engine, readonly
                from dictionary.libnames
                where libname not like 'SAS%';
            quit;
        `;
        const result = await this.submit(code);
        return this.parseLibraries(result.output);
    }

    async getDatasets(library: string): Promise<SASDataset[]> {
        const code = `
            proc sql noprint;
                select memname, nobs, nvars, crdate, modate, memlabel
                from dictionary.tables
                where libname = '${library.toUpperCase()}';
            quit;
        `;
        const result = await this.submit(code);
        return this.parseDatasets(library, result.output);
    }

    async getVariables(library: string, dataset: string): Promise<SASVariable[]> {
        const code = `
            proc contents data=${library}.${dataset} out=_vars_ noprint;
            run;
            proc print data=_vars_ noobs;
            run;
        `;
        const result = await this.submit(code);
        return this.parseVariables(result.output);
    }

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
        let datasetOptions = '';
        if (options) {
            const opts: string[] = [];
            if (options.firstObs) opts.push(`firstobs=${options.firstObs}`);
            if (options.obs) opts.push(`obs=${options.obs}`);
            if (options.keep) opts.push(`keep=${options.keep.join(' ')}`);
            if (options.drop) opts.push(`drop=${options.drop.join(' ')}`);
            if (options.where) opts.push(`where=(${options.where})`);
            if (opts.length > 0) {
                datasetOptions = `(${opts.join(' ')})`;
            }
        }

        const response = await this.sendCommand(JSON.stringify({
            command: 'get_data',
            library: library,
            dataset: dataset,
            options: options
        }));

        const result = JSON.parse(response);
        return {
            columns: result.columns,
            rows: result.rows
        };
    }

    private async sendCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.pythonProcess) {
                reject(new Error('Python process not running'));
                return;
            }

            let output = '';

            const onData = (data: Buffer) => {
                output += data.toString();
                // Check for end marker
                if (output.includes('__END_RESPONSE__')) {
                    this.pythonProcess.stdout.off('data', onData);
                    resolve(output.replace('__END_RESPONSE__', '').trim());
                }
            };

            this.pythonProcess.stdout.on('data', onData);

            this.pythonProcess.stderr.on('data', (data: Buffer) => {
                console.error('SASPy Error:', data.toString());
            });

            this.pythonProcess.stdin.write(command + '\n');
        });
    }

    private parseResponse(response: string): SASExecutionResult {
        try {
            const result = JSON.parse(response);
            return {
                log: result.log || '',
                output: result.output || '',
                status: result.errors?.length > 0 ? 'error' : 'success',
                errors: result.errors || [],
                warnings: result.warnings || []
            };
        } catch {
            return {
                log: response,
                output: '',
                status: 'success',
                errors: [],
                warnings: []
            };
        }
    }

    private parseLibraries(output: string): SASLibrary[] {
        // Parse library information from SAS output
        const libraries: SASLibrary[] = [];
        // Implementation depends on output format
        return libraries;
    }

    private parseDatasets(library: string, output: string): SASDataset[] {
        const datasets: SASDataset[] = [];
        // Implementation depends on output format
        return datasets;
    }

    private parseVariables(output: string): SASVariable[] {
        const variables: SASVariable[] = [];
        // Implementation depends on output format
        return variables;
    }
}

/**
 * IOM-based connection (placeholder for Java-based IOM)
 */
export class IOMConnection implements SASConnection {
    private profile: ConnectionProfile;
    private _isConnected: boolean = false;

    constructor(profile: ConnectionProfile) {
        this.profile = profile;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    get connectionType(): string {
        return 'iom';
    }

    async connect(): Promise<void> {
        // IOM connection would use Java bridge
        throw new Error('IOM connection not yet implemented');
    }

    async disconnect(): Promise<void> {
        this._isConnected = false;
    }

    async submit(code: string): Promise<SASExecutionResult> {
        throw new Error('IOM connection not yet implemented');
    }

    async submitAsync(code: string): Promise<string> {
        throw new Error('IOM connection not yet implemented');
    }

    async sendDebugCommand(command: string): Promise<string> {
        throw new Error('IOM connection not yet implemented');
    }

    async getLibraries(): Promise<SASLibrary[]> {
        throw new Error('IOM connection not yet implemented');
    }

    async getDatasets(library: string): Promise<SASDataset[]> {
        throw new Error('IOM connection not yet implemented');
    }

    async getVariables(library: string, dataset: string): Promise<SASVariable[]> {
        throw new Error('IOM connection not yet implemented');
    }

    async getData(
        library: string,
        dataset: string,
        options?: any
    ): Promise<{ columns: SASVariable[]; rows: any[][] }> {
        throw new Error('IOM connection not yet implemented');
    }
}

/**
 * SAS Viya REST API connection
 */
export class ViyaConnection implements SASConnection {
    private profile: ConnectionProfile;
    private _isConnected: boolean = false;
    private accessToken: string = '';

    constructor(profile: ConnectionProfile) {
        this.profile = profile;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    get connectionType(): string {
        return 'viya';
    }

    async connect(): Promise<void> {
        // Authenticate with Viya
        const response = await fetch(`https://${this.profile.host}/SASLogon/oauth/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `grant_type=password&username=${this.profile.username}`
        });

        if (!response.ok) {
            throw new Error(`Viya authentication failed: ${response.statusText}`);
        }

        const data = await response.json() as { access_token: string };
        this.accessToken = data.access_token;
        this._isConnected = true;
    }

    async disconnect(): Promise<void> {
        this.accessToken = '';
        this._isConnected = false;
    }

    async submit(code: string): Promise<SASExecutionResult> {
        // Submit job to Viya Compute Server
        const response = await fetch(`https://${this.profile.host}/compute/sessions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ code })
        });

        const result = await response.json() as any;
        return {
            log: result.log || '',
            output: result.output || '',
            status: result.status === 'completed' ? 'success' : 'error',
            errors: [],
            warnings: []
        };
    }

    async submitAsync(code: string): Promise<string> {
        const response = await fetch(`https://${this.profile.host}/jobExecution/jobs`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jobDefinition: { code }
            })
        });

        const result = await response.json() as { id: string };
        return result.id;
    }

    async sendDebugCommand(command: string): Promise<string> {
        // Viya doesn't support interactive debugging in the same way
        throw new Error('Interactive debugging not supported on Viya');
    }

    async getLibraries(): Promise<SASLibrary[]> {
        const response = await fetch(`https://${this.profile.host}/dataSources/providers/cas/sources`, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`
            }
        });

        const data = await response.json() as { items: any[] };
        return data.items.map((item: any) => ({
            name: item.name,
            path: item.path || '',
            engine: 'CAS',
            readonly: false
        }));
    }

    async getDatasets(library: string): Promise<SASDataset[]> {
        const response = await fetch(
            `https://${this.profile.host}/dataTables/dataSources/cas~fs~${library}/tables`,
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        const data = await response.json() as { items: any[] };
        return data.items.map((item: any) => ({
            name: item.name,
            library: library,
            nobs: item.rowCount || 0,
            nvars: item.columnCount || 0,
            created: new Date(item.creationTimeStamp),
            modified: new Date(item.modifiedTimeStamp),
            label: item.label
        }));
    }

    async getVariables(library: string, dataset: string): Promise<SASVariable[]> {
        const response = await fetch(
            `https://${this.profile.host}/dataTables/dataSources/cas~fs~${library}/tables/${dataset}/columns`,
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        const data = await response.json() as { items: any[] };
        return data.items.map((item: any) => ({
            name: item.name,
            type: item.type === 'double' ? 'numeric' : 'character',
            length: item.length || 0,
            format: item.format,
            label: item.label
        }));
    }

    async getData(
        library: string,
        dataset: string,
        options?: any
    ): Promise<{ columns: SASVariable[]; rows: any[][] }> {
        let url = `https://${this.profile.host}/dataTables/dataSources/cas~fs~${library}/tables/${dataset}/rows`;

        const params = new URLSearchParams();
        if (options?.firstObs) params.set('start', String(options.firstObs - 1));
        if (options?.obs) params.set('limit', String(options.obs));
        if (options?.where) params.set('filter', options.where);

        if (params.toString()) {
            url += '?' + params.toString();
        }

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`
            }
        });

        const data = await response.json() as { items: any[] };

        // Get columns first
        const columns = await this.getVariables(library, dataset);

        // Transform rows
        const rows = data.items.map((item: any) =>
            columns.map(col => item[col.name])
        );

        return { columns, rows };
    }
}

/**
 * SAS OnDemand for Academics (SODA) connection
 * Uses SASPy with IOM connection to SODA servers
 * FREE for everyone - great for testing!
 *
 * Setup requirements:
 * 1. Create free account at: https://welcome.oda.sas.com/
 * 2. Install Java 1.8.0_162 or higher
 * 3. Install SASPy: pip install saspy
 * 4. Create ~/.authinfo file with credentials
 */
export class SODAConnection implements SASConnection {
    private profile: ConnectionProfile;
    private _isConnected: boolean = false;
    private pythonProcess: any = null;

    constructor(profile: ConnectionProfile) {
        this.profile = profile;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    get connectionType(): string {
        return 'oda';
    }

    async connect(): Promise<void> {
        const config = vscode.workspace.getConfiguration('sasDebugger');
        const pythonPath = config.get<string>('pythonPath') || 'python';

        // Get SODA region servers
        const region = this.profile.sodaRegion || 'us1';
        const servers = SODA_SERVERS[region];

        if (!servers) {
            throw new Error(`Invalid SODA region: ${region}. Valid: us1, us2, eu1, eu2, ap1`);
        }

        // Start Python process with SASPy bridge
        const { spawn } = await import('child_process');
        const path = await import('path');

        const bridgePath = path.join(__dirname, '..', 'python', 'saspy_bridge.py');

        this.pythonProcess = spawn(pythonPath, [bridgePath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Send SODA connection configuration
        const connectConfig = JSON.stringify({
            command: 'connect_oda',
            config: {
                region: region,
                servers: servers,
                port: 8591,
                username: this.profile.sodaUsername
            }
        });

        const response = await this.sendCommand(connectConfig);
        const result = JSON.parse(response);

        if (result.status === 'error') {
            throw new Error(result.message || 'Failed to connect to SODA');
        }

        this._isConnected = true;
    }

    async disconnect(): Promise<void> {
        if (this.pythonProcess) {
            await this.sendCommand(JSON.stringify({ command: 'disconnect' }));
            this.pythonProcess.kill();
            this.pythonProcess = null;
        }
        this._isConnected = false;
    }

    async submit(code: string): Promise<SASExecutionResult> {
        const response = await this.sendCommand(JSON.stringify({
            command: 'submit',
            code: code
        }));

        return this.parseResponse(response);
    }

    async submitAsync(code: string): Promise<string> {
        const response = await this.sendCommand(JSON.stringify({
            command: 'submit_async',
            code: code
        }));

        const result = JSON.parse(response);
        return result.jobId;
    }

    async sendDebugCommand(command: string): Promise<string> {
        const response = await this.sendCommand(JSON.stringify({
            command: 'debug',
            debugCommand: command
        }));

        const result = JSON.parse(response);
        return result.output || '';
    }

    async getLibraries(): Promise<SASLibrary[]> {
        const code = `
            proc sql noprint;
                select libname, path, engine, readonly
                from dictionary.libnames
                where libname not like 'SAS%';
            quit;
        `;
        const result = await this.submit(code);
        return this.parseLibraries(result.output);
    }

    async getDatasets(library: string): Promise<SASDataset[]> {
        const code = `
            proc sql noprint;
                select memname, nobs, nvars, crdate, modate, memlabel
                from dictionary.tables
                where libname = '${library.toUpperCase()}';
            quit;
        `;
        const result = await this.submit(code);
        return this.parseDatasets(library, result.output);
    }

    async getVariables(library: string, dataset: string): Promise<SASVariable[]> {
        const code = `
            proc contents data=${library}.${dataset} out=_vars_ noprint;
            run;
        `;
        await this.submit(code);

        const response = await this.sendCommand(JSON.stringify({
            command: 'get_variables',
            library: 'WORK',
            dataset: '_vars_'
        }));

        const result = JSON.parse(response);
        return result.variables || [];
    }

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
        const response = await this.sendCommand(JSON.stringify({
            command: 'get_data',
            library: library,
            dataset: dataset,
            options: options
        }));

        const result = JSON.parse(response);
        return {
            columns: result.columns || [],
            rows: result.rows || []
        };
    }

    private async sendCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.pythonProcess) {
                reject(new Error('Python process not running'));
                return;
            }

            let output = '';

            const onData = (data: Buffer) => {
                output += data.toString();
                if (output.includes('__END_RESPONSE__')) {
                    this.pythonProcess.stdout.off('data', onData);
                    resolve(output.replace('__END_RESPONSE__', '').trim());
                }
            };

            this.pythonProcess.stdout.on('data', onData);

            this.pythonProcess.stderr.on('data', (data: Buffer) => {
                console.error('SODA Connection Error:', data.toString());
            });

            this.pythonProcess.stdin.write(command + '\n');
        });
    }

    private parseResponse(response: string): SASExecutionResult {
        try {
            const result = JSON.parse(response);
            return {
                log: result.log || '',
                output: result.output || '',
                status: result.errors?.length > 0 ? 'error' : 'success',
                errors: result.errors || [],
                warnings: result.warnings || []
            };
        } catch {
            return {
                log: response,
                output: '',
                status: 'success',
                errors: [],
                warnings: []
            };
        }
    }

    private parseLibraries(output: string): SASLibrary[] {
        const libraries: SASLibrary[] = [];
        return libraries;
    }

    private parseDatasets(library: string, output: string): SASDataset[] {
        const datasets: SASDataset[] = [];
        return datasets;
    }
}

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { OutputManager } from '../utils/outputManager';

export interface ConnectionProfile {
    name?: string;
    type: 'soda' | 'iom' | 'viya' | 'ssh';
    host?: string;
    port?: number;
    username?: string;
    region?: string;  // For SODA
    clientId?: string;  // For Viya
    clientSecret?: string;
}

export interface SubmitResult {
    log: string;
    output: string;
    hasErrors: boolean;
    hasWarnings: boolean;
}

export interface DatasetInfo {
    libref: string;
    name: string;
    rows: number;
    columns: number;
    size: number;
    modified: Date;
}

export interface LibraryInfo {
    name: string;
    path: string;
    engine: string;
    datasets: DatasetInfo[];
}

const SODA_SERVERS: Record<string, string> = {
    'us': 'odaws01-usw2.oda.sas.com',
    'eu': 'odaws01-euw1.oda.sas.com',
    'ap': 'odaws01-apse1.oda.sas.com'
};

export class SASConnectionManager extends EventEmitter {
    private pythonProcess: ChildProcess | null = null;
    private connected: boolean = false;
    private currentProfile: ConnectionProfile | null = null;
    private outputManager: OutputManager;
    private pendingRequests: Map<string, {
        resolve: (value: any) => void;
        reject: (error: any) => void;
    }> = new Map();
    private requestId: number = 0;

    constructor(outputManager: OutputManager) {
        super();
        this.outputManager = outputManager;
    }

    async connect(profile: ConnectionProfile): Promise<void> {
        if (this.connected) {
            await this.disconnect();
        }

        this.outputManager.log(`Connecting to SAS (${profile.type})...`);

        try {
            // Start Python bridge process
            await this.startPythonBridge();

            // Send connection command
            const connectCmd = this.buildConnectCommand(profile);
            const result = await this.sendCommand(connectCmd);

            if (result.success) {
                this.connected = true;
                this.currentProfile = profile;
                this.emit('connectionChange', true);
                this.outputManager.log('Successfully connected to SAS');
                vscode.window.showInformationMessage('Connected to SAS');
            } else {
                throw new Error(result.error || 'Connection failed');
            }
        } catch (error) {
            this.outputManager.error(`Connection failed: ${error}`);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.pythonProcess) {
            await this.sendCommand({ command: 'disconnect' });
            this.pythonProcess.kill();
            this.pythonProcess = null;
        }
        this.connected = false;
        this.currentProfile = null;
        this.emit('connectionChange', false);
        this.outputManager.log('Disconnected from SAS');
    }

    isConnected(): boolean {
        return this.connected;
    }

    getProfile(): ConnectionProfile | null {
        return this.currentProfile;
    }

    async submit(code: string): Promise<SubmitResult> {
        if (!this.connected) {
            throw new Error('Not connected to SAS');
        }

        const result = await this.sendCommand({
            command: 'submit',
            code
        });

        return {
            log: result.log || '',
            output: result.output || '',
            hasErrors: result.log?.includes('ERROR:') || false,
            hasWarnings: result.log?.includes('WARNING:') || false
        };
    }

    async getLibraries(): Promise<LibraryInfo[]> {
        if (!this.connected) {
            throw new Error('Not connected to SAS');
        }

        const result = await this.sendCommand({ command: 'get_libraries' });
        return result.libraries || [];
    }

    async getDatasets(libref: string): Promise<DatasetInfo[]> {
        if (!this.connected) {
            throw new Error('Not connected to SAS');
        }

        const result = await this.sendCommand({
            command: 'get_datasets',
            libref
        });
        return result.datasets || [];
    }

    async getDatasetData(
        libref: string,
        dataset: string,
        options?: { start?: number; limit?: number; filter?: string }
    ): Promise<{ columns: any[]; data: any[][]; totalRows: number }> {
        if (!this.connected) {
            throw new Error('Not connected to SAS');
        }

        const result = await this.sendCommand({
            command: 'get_data',
            libref,
            dataset,
            ...options
        });

        return {
            columns: result.columns || [],
            data: result.data || [],
            totalRows: result.totalRows || 0
        };
    }

    async getMacroVariables(): Promise<{ name: string; value: string; scope: string }[]> {
        if (!this.connected) {
            return [];
        }

        const result = await this.sendCommand({ command: 'get_macro_vars' });
        return result.variables || [];
    }

    async sendDebugCommand(command: string): Promise<string> {
        const result = await this.sendCommand({
            command: 'debug',
            debugCommand: command
        });
        return result.output || '';
    }

    onConnectionChange(callback: (connected: boolean) => void): void {
        this.on('connectionChange', callback);
    }

    private async startPythonBridge(): Promise<void> {
        return new Promise((resolve, reject) => {
            const config = vscode.workspace.getConfiguration('sasStudioAI');
            const pythonPath = config.get<string>('python.path') || 'python3';

            // Get extension path for Python script
            const extensionPath = vscode.extensions.getExtension('sas-studio-ai.sas-studio-ai')?.extensionPath
                || __dirname.replace(/[/\\]dist$/, '');
            const scriptPath = `${extensionPath}/python/sas_bridge.py`;

            this.pythonProcess = spawn(pythonPath, [scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let started = false;

            this.pythonProcess.stdout?.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const response = JSON.parse(line);

                        if (response.type === 'ready') {
                            started = true;
                            resolve();
                        } else if (response.requestId && this.pendingRequests.has(response.requestId)) {
                            const pending = this.pendingRequests.get(response.requestId)!;
                            this.pendingRequests.delete(response.requestId);

                            if (response.error) {
                                pending.reject(new Error(response.error));
                            } else {
                                pending.resolve(response);
                            }
                        }
                    } catch (e) {
                        // Not JSON, might be regular output
                        this.outputManager.log(line);
                    }
                }
            });

            this.pythonProcess.stderr?.on('data', (data: Buffer) => {
                this.outputManager.error(data.toString());
            });

            this.pythonProcess.on('error', (error) => {
                if (!started) {
                    reject(error);
                }
            });

            this.pythonProcess.on('exit', (code) => {
                if (!started) {
                    reject(new Error(`Python process exited with code ${code}`));
                }
                this.connected = false;
                this.emit('connectionChange', false);
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (!started) {
                    this.pythonProcess?.kill();
                    reject(new Error('Timeout starting Python bridge'));
                }
            }, 30000);
        });
    }

    private buildConnectCommand(profile: ConnectionProfile): any {
        const cmd: any = {
            command: 'connect',
            type: profile.type
        };

        switch (profile.type) {
            case 'soda':
                cmd.region = profile.region || 'us';
                cmd.host = SODA_SERVERS[cmd.region];
                break;

            case 'iom':
                cmd.host = profile.host;
                cmd.port = profile.port || 8591;
                cmd.username = profile.username;
                break;

            case 'viya':
                cmd.host = profile.host;
                cmd.clientId = profile.clientId;
                cmd.clientSecret = profile.clientSecret;
                break;

            case 'ssh':
                cmd.host = profile.host;
                cmd.port = profile.port || 22;
                cmd.username = profile.username;
                break;
        }

        return cmd;
    }

    private sendCommand(cmd: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.pythonProcess || !this.pythonProcess.stdin) {
                reject(new Error('Python bridge not running'));
                return;
            }

            const requestId = `req_${++this.requestId}`;
            cmd.requestId = requestId;

            this.pendingRequests.set(requestId, { resolve, reject });

            this.pythonProcess.stdin.write(JSON.stringify(cmd) + '\n');

            // Timeout after 5 minutes
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 300000);
        });
    }
}

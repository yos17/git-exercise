import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';

export interface IOMConnectionProfile {
    name?: string;
    type: 'soda' | 'iom' | 'viya';
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    region?: string;
}

export interface SubmitResult {
    log: string;
    output: string;
    hasErrors: boolean;
    hasWarnings: boolean;
}

export interface DebugState {
    status: 'running' | 'stepped' | 'breakpoint' | 'ended';
    currentLine: number;
    currentStatement: string;
    macroVariables: Map<string, string>;
    log: string;
}

/**
 * IOM Connection Manager - Java-based connection to SAS via IOM
 *
 * Uses native IOM protocol for:
 * - Better performance than SASPy
 * - Direct LanguageService access for debugging
 * - Full macro debugging support with step-through
 * - DataService for efficient data access
 */
export class IOMConnectionManager extends EventEmitter {
    private javaProcess: ChildProcess | null = null;
    private connected: boolean = false;
    private currentProfile: IOMConnectionProfile | null = null;
    private pendingRequests: Map<string, {
        resolve: (value: any) => void;
        reject: (error: any) => void;
    }> = new Map();
    private requestId: number = 0;
    private outputChannel: vscode.OutputChannel;

    constructor() {
        super();
        this.outputChannel = vscode.window.createOutputChannel('SAS IOM');
    }

    async connect(profile: IOMConnectionProfile): Promise<void> {
        if (this.connected) {
            await this.disconnect();
        }

        this.log(`Connecting via IOM (${profile.type})...`);

        try {
            await this.startJavaBridge();

            const result = await this.sendCommand({
                command: 'connect',
                ...profile
            });

            if (result.success) {
                this.connected = true;
                this.currentProfile = profile;
                this.emit('connectionChange', true);
                this.log('Connected to SAS via IOM');
                vscode.window.showInformationMessage('Connected to SAS via IOM');
            } else {
                throw new Error(result.error || 'Connection failed');
            }
        } catch (error) {
            this.log(`Connection failed: ${error}`);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.javaProcess) {
            await this.sendCommand({ command: 'disconnect' });
            this.javaProcess.kill();
            this.javaProcess = null;
        }
        this.connected = false;
        this.currentProfile = null;
        this.emit('connectionChange', false);
        this.log('Disconnected');
    }

    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Submit SAS code and wait for completion
     */
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
            hasErrors: result.hasErrors || false,
            hasWarnings: result.hasWarnings || false
        };
    }

    /**
     * Submit code asynchronously (for debugging)
     */
    async submitAsync(code: string): Promise<void> {
        if (!this.connected) {
            throw new Error('Not connected to SAS');
        }

        await this.sendCommand({
            command: 'submitAsync',
            code
        });
    }

    /**
     * Start debug session
     */
    async debugStart(code: string): Promise<DebugState> {
        const result = await this.sendCommand({
            command: 'debug_start',
            code
        });

        return {
            status: 'stepped',
            currentLine: result.currentLine || 1,
            currentStatement: result.currentStatement || '',
            macroVariables: new Map(Object.entries(result.macroVariables || {})),
            log: ''
        };
    }

    /**
     * Step to next statement
     */
    async debugStep(): Promise<DebugState> {
        const result = await this.sendCommand({ command: 'debug_step' });

        return {
            status: result.status || 'ended',
            currentLine: result.currentLine || 0,
            currentStatement: result.nextStatement || '',
            macroVariables: new Map(Object.entries(result.macroVariables || {})),
            log: result.log || ''
        };
    }

    /**
     * Step into macro
     */
    async debugStepInto(): Promise<DebugState> {
        const result = await this.sendCommand({ command: 'debug_step_into' });

        return {
            status: result.status || 'ended',
            currentLine: result.currentLine || 0,
            currentStatement: result.nextStatement || '',
            macroVariables: new Map(Object.entries(result.macroVariables || {})),
            log: result.log || ''
        };
    }

    /**
     * Continue until breakpoint
     */
    async debugContinue(): Promise<DebugState> {
        const result = await this.sendCommand({ command: 'debug_continue' });

        return {
            status: result.status || 'ended',
            currentLine: result.currentLine || 0,
            currentStatement: result.currentStatement || '',
            macroVariables: new Map(Object.entries(result.macroVariables || {})),
            log: result.log || ''
        };
    }

    /**
     * Set breakpoint
     */
    async setBreakpoint(line: number, condition?: string): Promise<number> {
        const result = await this.sendCommand({
            command: 'debug_set_breakpoint',
            line,
            condition
        });
        return result.breakpointId;
    }

    /**
     * Get current debug variables
     */
    async getDebugVariables(): Promise<Map<string, string>> {
        const result = await this.sendCommand({ command: 'debug_get_variables' });
        return new Map(Object.entries(result.variables || {}));
    }

    /**
     * Evaluate expression
     */
    async evaluate(expression: string): Promise<string> {
        const result = await this.sendCommand({
            command: 'evaluate',
            expression
        });
        return result.result || '';
    }

    /**
     * Get libraries
     */
    async getLibraries(): Promise<{ name: string }[]> {
        const result = await this.sendCommand({ command: 'get_libraries' });
        return result.libraries || [];
    }

    /**
     * Get datasets
     */
    async getDatasets(libref: string): Promise<{ name: string; rows: number; columns: number }[]> {
        const result = await this.sendCommand({
            command: 'get_datasets',
            libref
        });
        return result.datasets || [];
    }

    /**
     * Get macro variables
     */
    async getMacroVariables(): Promise<{ name: string; value: string; scope: string }[]> {
        const result = await this.sendCommand({ command: 'get_macro_vars' });
        return result.variables || [];
    }

    /**
     * Get data from dataset
     */
    async getData(
        libref: string,
        dataset: string,
        options?: { start?: number; limit?: number }
    ): Promise<{ columns: any[]; data: any[][]; totalRows: number }> {
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

    private async startJavaBridge(): Promise<void> {
        return new Promise((resolve, reject) => {
            const extensionPath = vscode.extensions.getExtension('sas-studio-ai.sas-studio-ai')?.extensionPath
                || path.join(__dirname, '..', '..');

            const javaPath = this.findJava();
            const jarPath = path.join(extensionPath, 'java', 'dist', 'sas-iom-bridge.jar');
            const libPath = path.join(extensionPath, 'java', 'lib');

            // Classpath includes SAS IOM JARs
            const classpath = [
                jarPath,
                path.join(libPath, '*')
            ].join(process.platform === 'win32' ? ';' : ':');

            this.javaProcess = spawn(javaPath, [
                '-cp', classpath,
                'com.sasstudioai.SASIOMBridge'
            ], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let started = false;

            this.javaProcess.stdout?.on('data', (data: Buffer) => {
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
                    } catch {
                        this.log(line);
                    }
                }
            });

            this.javaProcess.stderr?.on('data', (data: Buffer) => {
                this.log(`[ERROR] ${data.toString()}`);
            });

            this.javaProcess.on('error', (error) => {
                if (!started) {
                    reject(error);
                }
            });

            this.javaProcess.on('exit', (code) => {
                if (!started) {
                    reject(new Error(`Java process exited with code ${code}. Make sure Java and SAS IOM JARs are installed.`));
                }
                this.connected = false;
                this.emit('connectionChange', false);
            });

            setTimeout(() => {
                if (!started) {
                    this.javaProcess?.kill();
                    reject(new Error('Timeout starting Java IOM bridge'));
                }
            }, 30000);
        });
    }

    private findJava(): string {
        // Try common Java locations
        const javaLocations = [
            process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : '',
            '/usr/bin/java',
            '/opt/homebrew/opt/openjdk@11/bin/java',
            '/opt/homebrew/bin/java',
            'java'
        ].filter(p => p);

        // For now, return 'java' and let PATH resolve it
        return 'java';
    }

    private sendCommand(cmd: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.javaProcess || !this.javaProcess.stdin) {
                reject(new Error('Java IOM bridge not running'));
                return;
            }

            const requestId = `req_${++this.requestId}`;
            cmd.requestId = requestId;

            this.pendingRequests.set(requestId, { resolve, reject });

            this.javaProcess.stdin.write(JSON.stringify(cmd) + '\n');

            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 300000);
        });
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    onConnectionChange(callback: (connected: boolean) => void): void {
        this.on('connectionChange', callback);
    }
}

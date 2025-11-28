import { EventEmitter } from 'events';
import { IOMacroDebugger, MacroStatement } from './iomMacroDebugger';
import * as fs from 'fs';

export interface SASBreakpoint {
    id: number;
    line: number;
    verified: boolean;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
}

export interface RuntimeVariable {
    name: string;
    value: string;
    type: string;
}

export interface StackFrame {
    id: number;
    name: string;
    file: string;
    line: number;
}

export interface DebugOptions {
    debugDataSteps: boolean;
    debugMacros: boolean;
}

interface SASConnection {
    connect(): Promise<void>;
    submit(code: string): Promise<{ log: string; output: string }>;
    sendDebugCommand(command: string): Promise<string>;
    disconnect(): void;
}

/**
 * SAS Runtime - Manages SAS debugging session
 * Handles DATA step debugging via SAS debugger commands
 * and macro debugging via IOM LanguageService (step-through execution)
 */
export class SASRuntime extends EventEmitter {
    private static BREAKPOINT_ID = 1;
    private static FRAME_ID = 1;

    private connection: SASConnection | null = null;
    private sourceFile: string = '';
    private sourceLines: string[] = [];
    private currentLine: number = 1;
    private debugOptions: DebugOptions = { debugDataSteps: true, debugMacros: true };

    // Breakpoints
    private breakpoints: Map<string, SASBreakpoint[]> = new Map();
    private dataBreakpoints: Map<string, SASBreakpoint> = new Map();

    // Execution state
    private isRunning: boolean = false;
    private isPaused: boolean = false;
    private inDataStep: boolean = false;
    private inMacro: boolean = false;

    // Variable storage
    private pdvVariables: Map<string, RuntimeVariable> = new Map();
    private globalMacroVars: Map<string, RuntimeVariable> = new Map();
    private localMacroVars: Map<string, RuntimeVariable> = new Map();
    private automaticVars: Map<string, RuntimeVariable> = new Map();

    // Stack
    private dataStepStack: { name: string; line: number }[] = [];
    private macroStack: { name: string; line: number }[] = [];

    // IOM Macro Debugger
    private macroDebugger: IOMacroDebugger;
    private currentMacroStatement: MacroStatement | null = null;

    // Exception tracking
    private lastException: { id: string; description: string; message: string; type: string } | null = null;

    constructor() {
        super();
        this.macroDebugger = new IOMacroDebugger();
        this.setupMacroDebuggerEvents();
        this.initializeAutomaticVariables();
    }

    private setupMacroDebuggerEvents(): void {
        this.macroDebugger.on('stopOnEntry', (stmt: MacroStatement) => {
            this.currentMacroStatement = stmt;
            this.currentLine = stmt.line;
            this.inMacro = true;
            this.isPaused = true;
            this.emit('stopOnEntry');
        });

        this.macroDebugger.on('stopOnStep', (stmt: MacroStatement) => {
            this.currentMacroStatement = stmt;
            this.currentLine = stmt.line;
            this.isPaused = true;
            this.emit('stopOnStep');
        });

        this.macroDebugger.on('stopOnBreakpoint', (stmt: MacroStatement) => {
            this.currentMacroStatement = stmt;
            this.currentLine = stmt.line;
            this.isPaused = true;
            this.emit('stopOnBreakpoint');
        });

        this.macroDebugger.on('output', (text: string, category: string) => {
            this.emit('output', text, category);
        });

        this.macroDebugger.on('error', (stmt: MacroStatement, error: Error) => {
            this.lastException = {
                id: 'MACRO_ERROR',
                description: 'Macro execution error',
                message: error.message,
                type: 'MacroException'
            };
            this.emit('stopOnException', error.message);
        });

        this.macroDebugger.on('end', () => {
            this.inMacro = false;
            this.updateMacroVarsFromDebugger();
            if (!this.inDataStep) {
                this.isRunning = false;
                this.emit('end');
            }
        });

        this.macroDebugger.on('afterExecute', () => {
            this.updateMacroVarsFromDebugger();
        });
    }

    private initializeAutomaticVariables(): void {
        // SAS automatic variables available during DATA step
        const autoVars = [
            { name: '_N_', value: '1', type: 'num' },
            { name: '_ERROR_', value: '0', type: 'num' },
            { name: '_IORC_', value: '0', type: 'num' },
            { name: 'FIRST.', value: '1', type: 'num' },
            { name: 'LAST.', value: '0', type: 'num' }
        ];

        for (const v of autoVars) {
            this.automaticVars.set(v.name, v);
        }
    }

    private updateMacroVarsFromDebugger(): void {
        const globalVars = this.macroDebugger.getGlobalMacroVars();
        this.globalMacroVars.clear();
        for (const [name, value] of globalVars) {
            this.globalMacroVars.set(name, { name, value, type: 'macro' });
        }

        const localVars = this.macroDebugger.getLocalMacroVars();
        this.localMacroVars.clear();
        for (const [name, value] of localVars) {
            this.localMacroVars.set(name, { name, value, type: 'macro' });
        }
    }

    async initialize(profileName: string): Promise<void> {
        // In a real implementation, this would create a SAS connection
        this.emit('output', `Initializing with profile: ${profileName}`, 'console');
    }

    async loadProgram(filePath: string, options: DebugOptions): Promise<void> {
        this.sourceFile = filePath;
        this.debugOptions = options;

        const content = fs.readFileSync(filePath, 'utf-8');
        this.sourceLines = content.split('\n');

        // Parse for DATA steps and macros
        this.analyzeProgram();

        // Set up macro debugger if enabled
        if (options.debugMacros && this.connection) {
            this.macroDebugger.setSubmitCallback(async (code: string) => {
                const result = await this.connection!.submit(code);
                return { log: result.log, output: result.output };
            });
            this.macroDebugger.parseSource(content);
        }
    }

    private analyzeProgram(): void {
        // Find DATA steps and macros in the source
        let inDataStep = false;
        let inMacro = false;
        let dataStepStart = 0;
        let macroStart = 0;

        for (let i = 0; i < this.sourceLines.length; i++) {
            const line = this.sourceLines[i].trim().toUpperCase();

            if (line.startsWith('DATA ') && !line.includes('_NULL_')) {
                inDataStep = true;
                dataStepStart = i + 1;
            } else if (line.startsWith('RUN;') && inDataStep) {
                inDataStep = false;
            } else if (line.startsWith('%MACRO ')) {
                inMacro = true;
                macroStart = i + 1;
            } else if (line.startsWith('%MEND')) {
                inMacro = false;
            }
        }
    }

    async start(stopOnEntry: boolean): Promise<void> {
        this.isRunning = true;
        this.currentLine = 1;

        // Check if program starts with macro code
        const firstExecutableLine = this.findFirstExecutableLine();

        if (stopOnEntry) {
            this.isPaused = true;
            this.emit('stopOnEntry');
        } else {
            await this.continue();
        }
    }

    private findFirstExecutableLine(): number {
        for (let i = 0; i < this.sourceLines.length; i++) {
            const line = this.sourceLines[i].trim();
            if (line && !line.startsWith('/*') && !line.startsWith('*')) {
                return i + 1;
            }
        }
        return 1;
    }

    async continue(): Promise<void> {
        if (!this.isPaused) return;

        if (this.inMacro && this.debugOptions.debugMacros) {
            this.isPaused = false;
            await this.macroDebugger.continue();
            return;
        }

        if (this.connection && this.inDataStep) {
            this.isPaused = false;
            await this.sendDebugCommand('GO');
        }
    }

    async step(): Promise<void> {
        if (!this.isPaused) return;

        if (this.inMacro && this.debugOptions.debugMacros) {
            await this.macroDebugger.stepOver();
            return;
        }

        if (this.connection && this.inDataStep) {
            await this.sendDebugCommand('STEP');
        }
    }

    async stepIn(): Promise<void> {
        if (!this.isPaused) return;

        if (this.inMacro && this.debugOptions.debugMacros) {
            await this.macroDebugger.stepInto();
            return;
        }

        if (this.connection && this.inDataStep) {
            await this.sendDebugCommand('STEP');
        }
    }

    async stepOut(): Promise<void> {
        if (!this.isPaused) return;

        if (this.inMacro && this.debugOptions.debugMacros) {
            await this.macroDebugger.stepOut();
            return;
        }

        if (this.connection && this.inDataStep) {
            await this.sendDebugCommand('GO');
        }
    }

    pause(): void {
        this.emit('output', 'Pause not supported - use breakpoints', 'console');
    }

    terminate(): void {
        this.isRunning = false;
        this.isPaused = false;
        if (this.connection) {
            this.connection.disconnect();
        }
        this.emit('end');
    }

    private async sendDebugCommand(command: string): Promise<void> {
        if (!this.connection) return;

        try {
            const result = await this.connection.sendDebugCommand(command);
            await this.parseDebugLog(result);
        } catch (error) {
            this.emit('output', `Debug command error: ${error}`, 'stderr');
        }
    }

    private async parseDebugLog(log: string): Promise<void> {
        const lines = log.split('\n');

        for (const line of lines) {
            // Parse breakpoint hit
            if (line.includes('Stopped at line')) {
                const match = line.match(/line (\d+)/);
                if (match) {
                    this.currentLine = parseInt(match[1]);
                    this.isPaused = true;
                    this.emit('stopOnBreakpoint');
                }
            }

            // Parse variable changes
            if (line.includes('=')) {
                const match = line.match(/(\w+)\s*=\s*(.+)/);
                if (match) {
                    const [, name, value] = match;
                    this.pdvVariables.set(name.toUpperCase(), {
                        name: name.toUpperCase(),
                        value: value.trim(),
                        type: isNaN(parseFloat(value)) ? 'char' : 'num'
                    });
                }
            }

            // Parse errors
            if (line.includes('ERROR:')) {
                this.emit('output', line, 'stderr');
            } else if (line.includes('WARNING:')) {
                this.emit('output', line, 'console');
            }
        }
    }

    setBreakpoint(
        file: string,
        line: number,
        condition?: string,
        hitCondition?: string,
        logMessage?: string
    ): SASBreakpoint {
        const bp: SASBreakpoint = {
            id: SASRuntime.BREAKPOINT_ID++,
            line,
            verified: true,
            condition,
            hitCondition,
            logMessage
        };

        let bps = this.breakpoints.get(file);
        if (!bps) {
            bps = [];
            this.breakpoints.set(file, bps);
        }
        bps.push(bp);

        // Sync with macro debugger
        if (this.debugOptions.debugMacros) {
            this.macroDebugger.setBreakpoint(line, condition);
        }

        this.emit('breakpointValidated', bp);
        return bp;
    }

    clearBreakpoints(file: string): void {
        const existingBps = this.breakpoints.get(file) || [];
        for (const bp of existingBps) {
            this.macroDebugger.removeBreakpointByLine(bp.line);
        }
        this.breakpoints.set(file, []);
    }

    setDataBreakpoint(variableName: string): SASBreakpoint {
        const bp: SASBreakpoint = {
            id: SASRuntime.BREAKPOINT_ID++,
            line: 0,
            verified: true
        };

        this.dataBreakpoints.set(variableName.toUpperCase(), bp);

        if (this.connection && this.isPaused) {
            this.sendDebugCommand(`WATCH ${variableName}`);
        }

        return bp;
    }

    getStackTrace(startFrame: number, maxLevels: number): { frames: StackFrame[]; count: number } {
        const frames: StackFrame[] = [];
        let frameId = SASRuntime.FRAME_ID;

        // Current location
        frames.push({
            id: frameId++,
            name: this.inMacro ? 'Macro Execution' : this.inDataStep ? 'DATA Step' : 'SAS Program',
            file: this.sourceFile,
            line: this.currentLine
        });

        // Add DATA step frames
        for (const ds of this.dataStepStack) {
            frames.push({
                id: frameId++,
                name: `DATA ${ds.name}`,
                file: this.sourceFile,
                line: ds.line
            });
        }

        // Add macro frames
        for (const macro of this.macroStack) {
            frames.push({
                id: frameId++,
                name: `%${macro.name}`,
                file: this.sourceFile,
                line: macro.line
            });
        }

        return { frames, count: frames.length };
    }

    getPDVVariables(): RuntimeVariable[] {
        return Array.from(this.pdvVariables.values());
    }

    getGlobalMacroVariables(): RuntimeVariable[] {
        return Array.from(this.globalMacroVars.values());
    }

    getLocalMacroVariables(): RuntimeVariable[] {
        return Array.from(this.localMacroVars.values());
    }

    getAutomaticVariables(): RuntimeVariable[] {
        return Array.from(this.automaticVars.values());
    }

    getLastException(): { id: string; description: string; message: string; type: string } | null {
        return this.lastException;
    }

    async evaluateExpression(expression: string): Promise<string> {
        const varName = expression.toUpperCase().trim();

        // Check PDV variables
        const pdvVar = this.pdvVariables.get(varName);
        if (pdvVar) return pdvVar.value;

        // Check automatic variables
        const autoVar = this.automaticVars.get(varName);
        if (autoVar) return autoVar.value;

        return `Variable ${expression} not found`;
    }

    async evaluateMacroExpression(expression: string): Promise<string> {
        const varName = expression.replace(/^&|%/g, '').toUpperCase().trim();

        // Check global macro variables
        const globalVar = this.globalMacroVars.get(varName);
        if (globalVar) return globalVar.value;

        // Check local macro variables
        const localVar = this.localMacroVars.get(varName);
        if (localVar) return localVar.value;

        return `Macro variable ${expression} not found`;
    }

    async setVariable(name: string, value: string): Promise<string> {
        if (this.connection && this.isPaused && this.inDataStep) {
            await this.sendDebugCommand(`SET ${name} = ${value}`);
            return value;
        }
        throw new Error('Cannot set variable outside DATA step debugging');
    }

    async setMacroVariable(name: string, value: string): Promise<string> {
        if (this.connection) {
            await this.connection.submit(`%let ${name} = ${value};`);
            this.globalMacroVars.set(name.toUpperCase(), {
                name: name.toUpperCase(),
                value,
                type: 'macro'
            });
            return value;
        }
        throw new Error('Not connected to SAS');
    }
}

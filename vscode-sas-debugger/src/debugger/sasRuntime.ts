import { EventEmitter } from 'events';
import { SASConnection, SASConnectionFactory } from '../connection/sasConnection';
import { IOMacroDebugger, MacroStatement } from './iomMacroDebugger';
import * as fs from 'fs';
import * as path from 'path';

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

export interface BreakpointLocation {
    line: number;
    column?: number;
}

export interface DebugOptions {
    debugDataSteps: boolean;
    debugMacros: boolean;
}

interface DataStepContext {
    name: string;
    line: number;
    variables: Map<string, RuntimeVariable>;
}

interface MacroContext {
    name: string;
    line: number;
    localVars: Map<string, RuntimeVariable>;
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
    private callStack: StackFrame[] = [];
    private dataStepStack: DataStepContext[] = [];
    private macroStack: MacroContext[] = [];

    // IOM Macro Debugger for step-through macro execution
    private macroDebugger: IOMacroDebugger;
    private currentMacroStatement: MacroStatement | null = null;

    // Last exception
    private lastException: { id: string; description: string; message: string; type: string } | null = null;

    constructor() {
        super();

        // Initialize IOM macro debugger
        this.macroDebugger = new IOMacroDebugger();
        this.setupMacroDebuggerEvents();
    }

    /**
     * Set up event handlers for IOM macro debugger
     */
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

        this.macroDebugger.on('beforeExecute', (stmt: MacroStatement) => {
            this.emit('output', `Executing: ${stmt.text}`, 'console');
        });

        this.macroDebugger.on('afterExecute', (stmt: MacroStatement, result: { log: string }) => {
            // Update macro variables from execution result
            this.updateMacroVarsFromDebugger();
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
            if (!this.inDataStep) {
                this.isRunning = false;
                this.emit('end');
            }
        });
    }

    /**
     * Update macro variables from IOM debugger state
     */
    private updateMacroVarsFromDebugger(): void {
        // Get global macro variables
        const globalVars = this.macroDebugger.getGlobalMacroVars();
        this.globalMacroVars.clear();
        for (const [name, value] of globalVars) {
            this.globalMacroVars.set(name, {
                name,
                value,
                type: 'macro'
            });
        }

        // Get local macro variables
        const localVars = this.macroDebugger.getLocalMacroVars();
        this.localMacroVars.clear();
        for (const [name, value] of localVars) {
            this.localMacroVars.set(name, {
                name,
                value,
                type: 'macro'
            });
        }

        // Update macro stack
        const callStack = this.macroDebugger.getCallStack();
        this.macroStack = callStack.map(frame => ({
            name: frame.name,
            line: frame.line,
            localVars: new Map()
        }));
    }

    /**
     * Initialize the runtime with a connection profile
     */
    async initialize(profileName: string): Promise<void> {
        this.connection = await SASConnectionFactory.create(profileName);
        await this.connection.connect();
        this.emit('output', `Connected to SAS via profile: ${profileName}`, 'console');
    }

    /**
     * Load a SAS program for debugging
     */
    async loadProgram(filePath: string, options: DebugOptions): Promise<void> {
        this.sourceFile = filePath;
        this.debugOptions = options;

        const content = fs.readFileSync(filePath, 'utf-8');
        this.sourceLines = content.split('\n');

        // Parse the program to identify DATA steps and macros
        this.analyzeProgram();

        // Set up IOM macro debugger if macro debugging enabled
        if (options.debugMacros && this.connection) {
            // Set up submit callback for IOM-based macro execution
            this.macroDebugger.setSubmitCallback(async (code: string) => {
                const result = await this.connection!.submit(code);
                return { log: result.log, output: result.output };
            });

            // Parse macro code for step-through debugging
            this.macroDebugger.parseSource(content);

            this.emit('output', `Parsed ${this.macroDebugger.getStatements().length} macro statements for IOM debugging`, 'console');
        }

        this.emit('output', `Loaded program: ${filePath}`, 'console');
    }

    /**
     * Analyze the program to find debuggable sections
     */
    private analyzeProgram(): void {
        const dataStepPattern = /^\s*data\s+(\w+)/i;
        const macroDefPattern = /^\s*%macro\s+(\w+)/i;
        const macroEndPattern = /^\s*%mend/i;

        let inMacroDef = false;

        for (let i = 0; i < this.sourceLines.length; i++) {
            const line = this.sourceLines[i];

            if (dataStepPattern.test(line)) {
                // Found DATA step - can be debugged
                this.emit('output', `Found DATA step at line ${i + 1}`, 'console');
            }

            if (macroDefPattern.test(line)) {
                inMacroDef = true;
                this.emit('output', `Found macro definition at line ${i + 1}`, 'console');
            }

            if (macroEndPattern.test(line)) {
                inMacroDef = false;
            }
        }
    }

    /**
     * Start program execution
     */
    async start(stopOnEntry: boolean): Promise<void> {
        this.isRunning = true;
        this.currentLine = 1;

        // Use IOM macro debugger for macro code if enabled
        if (this.debugOptions.debugMacros && this.hasMacroCode()) {
            this.emit('output', 'Starting IOM-based macro debugging...', 'console');

            // Set up macro breakpoints from runtime breakpoints
            const bps = this.breakpoints.get(this.sourceFile) || [];
            for (const bp of bps) {
                this.macroDebugger.setBreakpoint(bp.line, undefined, bp.condition);
            }

            // Start macro debugger
            await this.macroDebugger.start(stopOnEntry);
            return;
        }

        // Build the modified program with debugging enabled (DATA step only)
        const debugProgram = this.buildDebugProgram();

        if (stopOnEntry) {
            this.isPaused = true;
            this.emit('stopOnEntry');
        } else {
            await this.runProgram(debugProgram);
        }
    }

    /**
     * Check if program contains macro code
     */
    private hasMacroCode(): boolean {
        const macroPattern = /^\s*%macro\s+/im;
        return macroPattern.test(this.sourceLines.join('\n'));
    }

    /**
     * Build program with debug options injected
     * Note: Uses DATA step debugger, not MLOGIC/MPRINT (IOM handles macros)
     */
    private buildDebugProgram(): string {
        let program = '';

        // Don't add MLOGIC/MPRINT - IOM debugger handles macro debugging
        // Only add if not using IOM macro debugging
        if (this.debugOptions.debugMacros && !this.hasMacroCode()) {
            // Fallback to log-based debugging for simple cases
            program += 'options symbolgen;\n';
        }

        // Process each line
        const dataStepPattern = /^(\s*data\s+\w+)/i;

        for (let i = 0; i < this.sourceLines.length; i++) {
            let line = this.sourceLines[i];

            // Inject /debug option for DATA steps
            if (this.debugOptions.debugDataSteps && dataStepPattern.test(line)) {
                const hasBreakpoints = this.hasBreakpointsInDataStep(i);
                if (hasBreakpoints) {
                    line = line.replace(dataStepPattern, '$1 / debug');
                }
            }

            program += line + '\n';
        }

        return program;
    }

    /**
     * Check if there are breakpoints in the DATA step starting at line
     */
    private hasBreakpointsInDataStep(startLine: number): boolean {
        const bps = this.breakpoints.get(this.sourceFile) || [];
        const runPattern = /^\s*run\s*;/i;

        for (let i = startLine; i < this.sourceLines.length; i++) {
            if (runPattern.test(this.sourceLines[i])) {
                break;
            }
            if (bps.some(bp => bp.line === i + 1)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Run the program with debugging
     */
    private async runProgram(program: string): Promise<void> {
        if (!this.connection) {
            throw new Error('Not connected to SAS');
        }

        try {
            // Submit the program
            const result = await this.connection.submit(program);

            // Parse the log for debugging information
            await this.parseDebugLog(result.log);

            if (!this.isPaused) {
                this.isRunning = false;
                this.emit('end');
            }
        } catch (error) {
            this.lastException = {
                id: 'RUNTIME_ERROR',
                description: 'SAS execution error',
                message: String(error),
                type: 'RuntimeException'
            };
            this.emit('stopOnException', String(error));
        }
    }

    /**
     * Parse debug log output
     */
    private async parseDebugLog(log: string): Promise<void> {
        const lines = log.split('\n');

        // Patterns for macro debugging
        const mlogicPattern = /^MLOGIC\((\w+)\):\s*(.+)/;
        const mprintPattern = /^MPRINT\((\w+)\):\s*(.+)/;
        const symbolgenPattern = /^SYMBOLGEN:\s*Macro variable (\w+) resolves to (.+)/;

        // Pattern for DATA step debugger
        const debugLinePattern = /^Stopped at line (\d+)/;
        const debugVarPattern = /^(\w+)\s*=\s*(.+)/;

        for (const line of lines) {
            // Check for macro tracing
            let match = mlogicPattern.exec(line);
            if (match) {
                const [, macroName, message] = match;
                this.emit('output', `[MLOGIC] ${macroName}: ${message}`, 'console');

                if (message.includes('Beginning execution')) {
                    this.macroStack.push({
                        name: macroName,
                        line: this.currentLine,
                        localVars: new Map()
                    });
                } else if (message.includes('Ending execution')) {
                    this.macroStack.pop();
                }
                continue;
            }

            match = symbolgenPattern.exec(line);
            if (match) {
                const [, varName, value] = match;
                this.globalMacroVars.set(varName.toUpperCase(), {
                    name: varName,
                    value: value,
                    type: 'macro'
                });
                this.emit('output', `[SYMBOLGEN] &${varName} = ${value}`, 'console');
                continue;
            }

            match = mprintPattern.exec(line);
            if (match) {
                const [, macroName, code] = match;
                this.emit('output', `[MPRINT] ${macroName}: ${code}`, 'console');
                continue;
            }

            // Check for DATA step debugger output
            match = debugLinePattern.exec(line);
            if (match) {
                this.currentLine = parseInt(match[1]);
                this.isPaused = true;
                this.emit('stopOnStep');
                continue;
            }

            // Check for errors
            if (line.includes('ERROR:')) {
                this.emit('output', line, 'stderr');
            } else if (line.includes('WARNING:')) {
                this.emit('output', line, 'console');
            }
        }
    }

    /**
     * Continue execution
     */
    async continue(): Promise<void> {
        if (!this.isPaused) return;

        // If in macro debugging mode via IOM, delegate to macro debugger
        if (this.inMacro && this.debugOptions.debugMacros) {
            this.isPaused = false;
            await this.macroDebugger.continue();
            return;
        }

        // For DATA step debugging, use SAS debugger GO command
        if (this.connection && this.inDataStep) {
            this.isPaused = false;
            this.sendDebugCommand('GO');
        }
    }

    /**
     * Step to next statement
     */
    async step(): Promise<void> {
        if (!this.isPaused) return;

        // If in macro debugging mode via IOM, use macro debugger stepOver
        if (this.inMacro && this.debugOptions.debugMacros) {
            await this.macroDebugger.stepOver();
            return;
        }

        // For DATA step debugging, use SAS debugger STEP command
        if (this.connection && this.inDataStep) {
            this.sendDebugCommand('STEP');
        }
    }

    /**
     * Step into (for macros - steps into macro calls)
     */
    async stepIn(): Promise<void> {
        if (!this.isPaused) return;

        // If in macro debugging mode via IOM, use macro debugger stepInto
        if (this.inMacro && this.debugOptions.debugMacros) {
            await this.macroDebugger.stepInto();
            return;
        }

        // For DATA step, step into treats as regular step
        // (DATA steps don't have step-into capability)
        if (this.connection && this.inDataStep) {
            this.sendDebugCommand('STEP');
        }
    }

    /**
     * Step out (exit current macro or DATA step)
     */
    async stepOut(): Promise<void> {
        if (!this.isPaused) return;

        // If in macro debugging mode via IOM, use macro debugger stepOut
        if (this.inMacro && this.debugOptions.debugMacros) {
            await this.macroDebugger.stepOut();
            return;
        }

        // For DATA step debugging, jump to end of current step
        if (this.connection && this.inDataStep) {
            this.sendDebugCommand('GO');
        }
    }

    /**
     * Pause execution
     */
    pause(): void {
        // SAS doesn't support pause during execution
        // We can only pause at breakpoints
        this.emit('output', 'Pause not supported - use breakpoints', 'console');
    }

    /**
     * Send command to SAS debugger
     */
    private async sendDebugCommand(command: string): Promise<void> {
        if (!this.connection) return;

        try {
            const result = await this.connection.sendDebugCommand(command);
            await this.parseDebugLog(result);
        } catch (error) {
            this.emit('output', `Debug command error: ${error}`, 'stderr');
        }
    }

    /**
     * Set a breakpoint
     */
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

        // Also set breakpoint in IOM macro debugger if debugging macros
        if (this.debugOptions.debugMacros) {
            this.macroDebugger.setBreakpoint(line, condition);
        }

        this.emit('breakpointValidated', bp);
        return bp;
    }

    /**
     * Clear breakpoints for a file
     */
    clearBreakpoints(file: string): void {
        // Get existing breakpoints to clear them from macro debugger
        const existingBps = this.breakpoints.get(file) || [];
        for (const bp of existingBps) {
            this.macroDebugger.removeBreakpointByLine(bp.line);
        }

        this.breakpoints.set(file, []);
    }

    /**
     * Set a data breakpoint (watch variable)
     */
    setDataBreakpoint(variableName: string): SASBreakpoint {
        const bp: SASBreakpoint = {
            id: SASRuntime.BREAKPOINT_ID++,
            line: 0,
            verified: true
        };

        this.dataBreakpoints.set(variableName.toUpperCase(), bp);

        // Send WATCH command to SAS debugger
        if (this.connection && this.isPaused) {
            this.sendDebugCommand(`WATCH ${variableName}`);
        }

        return bp;
    }

    /**
     * Get stack trace
     */
    getStackTrace(startFrame: number, maxLevels: number): { frames: StackFrame[]; count: number } {
        const frames: StackFrame[] = [];
        let frameId = SASRuntime.FRAME_ID;

        // Add DATA step frame if in DATA step
        if (this.dataStepStack.length > 0) {
            const ds = this.dataStepStack[this.dataStepStack.length - 1];
            frames.push({
                id: frameId++,
                name: `DATA ${ds.name}`,
                file: this.sourceFile,
                line: this.currentLine
            });
        }

        // Add macro frames
        for (let i = this.macroStack.length - 1; i >= 0; i--) {
            const macro = this.macroStack[i];
            frames.push({
                id: frameId++,
                name: `%${macro.name}`,
                file: this.sourceFile,
                line: macro.line
            });
        }

        // If no frames, add main program frame
        if (frames.length === 0) {
            frames.push({
                id: frameId++,
                name: 'Main Program',
                file: this.sourceFile,
                line: this.currentLine
            });
        }

        return {
            frames: frames.slice(startFrame, startFrame + maxLevels),
            count: frames.length
        };
    }

    /**
     * Get PDV (Program Data Vector) variables
     */
    async getPDVVariables(): Promise<RuntimeVariable[]> {
        if (this.connection && this.isPaused && this.inDataStep) {
            const result = await this.sendDebugCommandWithResponse('EXAMINE _ALL_');
            this.parsePDVVariables(result);
        }
        return Array.from(this.pdvVariables.values());
    }

    /**
     * Parse PDV variables from EXAMINE output
     */
    private parsePDVVariables(output: string): void {
        this.pdvVariables.clear();
        const varPattern = /(\w+)\s*=\s*(.+)/g;
        let match;

        while ((match = varPattern.exec(output)) !== null) {
            const [, name, value] = match;
            this.pdvVariables.set(name.toUpperCase(), {
                name,
                value: value.trim(),
                type: this.inferType(value)
            });
        }
    }

    /**
     * Infer variable type from value
     */
    private inferType(value: string): string {
        if (value === '.' || value === '') return 'missing';
        if (/^-?\d+\.?\d*$/.test(value)) return 'numeric';
        return 'character';
    }

    /**
     * Get global macro variables
     */
    async getGlobalMacroVariables(): Promise<RuntimeVariable[]> {
        if (this.connection) {
            // Get system macro variables via %put _global_
            const result = await this.connection.submit('%put _global_;');
            this.parseGlobalMacroVars(result.log);
        }
        return Array.from(this.globalMacroVars.values());
    }

    /**
     * Parse global macro variables from log
     */
    private parseGlobalMacroVars(log: string): void {
        const varPattern = /^GLOBAL\s+(\w+)\s+(.*)$/gm;
        let match;

        while ((match = varPattern.exec(log)) !== null) {
            const [, name, value] = match;
            this.globalMacroVars.set(name.toUpperCase(), {
                name,
                value: value.trim(),
                type: 'macro'
            });
        }
    }

    /**
     * Get local macro variables
     */
    async getLocalMacroVariables(): Promise<RuntimeVariable[]> {
        if (this.connection && this.macroStack.length > 0) {
            const result = await this.connection.submit('%put _local_;');
            this.parseLocalMacroVars(result.log);
        }
        return Array.from(this.localMacroVars.values());
    }

    /**
     * Parse local macro variables from log
     */
    private parseLocalMacroVars(log: string): void {
        this.localMacroVars.clear();
        const varPattern = /^(\w+)\s+(\w+)\s+(.*)$/gm;
        let match;

        while ((match = varPattern.exec(log)) !== null) {
            const [, scope, name, value] = match;
            if (scope !== 'GLOBAL') {
                this.localMacroVars.set(name.toUpperCase(), {
                    name,
                    value: value.trim(),
                    type: 'macro'
                });
            }
        }
    }

    /**
     * Get automatic variables (_N_, _ERROR_, etc.)
     */
    async getAutomaticVariables(): Promise<RuntimeVariable[]> {
        return [
            { name: '_N_', value: String(this.pdvVariables.get('_N_')?.value || '1'), type: 'numeric' },
            { name: '_ERROR_', value: String(this.pdvVariables.get('_ERROR_')?.value || '0'), type: 'numeric' },
            { name: '_IORC_', value: String(this.pdvVariables.get('_IORC_')?.value || '0'), type: 'numeric' }
        ];
    }

    /**
     * Evaluate an expression
     */
    async evaluate(expression: string, context?: string): Promise<{ value: string; type: string }> {
        if (!this.connection) {
            return { value: 'Not connected', type: 'error' };
        }

        // Check if it's a macro variable
        if (expression.startsWith('&')) {
            const varName = expression.slice(1).toUpperCase();
            const value = this.globalMacroVars.get(varName) || this.localMacroVars.get(varName);
            if (value) {
                return { value: value.value, type: 'macro' };
            }
        }

        // Check PDV variables
        const pdvVar = this.pdvVariables.get(expression.toUpperCase());
        if (pdvVar) {
            return { value: pdvVar.value, type: pdvVar.type };
        }

        // Try to evaluate via EXAMINE command
        if (this.isPaused && this.inDataStep) {
            const result = await this.sendDebugCommandWithResponse(`EXAMINE ${expression}`);
            return { value: result.trim(), type: 'evaluated' };
        }

        return { value: 'Cannot evaluate', type: 'unknown' };
    }

    /**
     * Set a variable value
     */
    async setVariable(name: string, value: string): Promise<string> {
        if (!this.connection || !this.isPaused) {
            throw new Error('Cannot set variable: not in debug mode');
        }

        // For PDV variables, use SET command
        await this.sendDebugCommand(`SET ${name} = ${value}`);
        return value;
    }

    /**
     * Send debug command and get response
     */
    private async sendDebugCommandWithResponse(command: string): Promise<string> {
        if (!this.connection) return '';
        return await this.connection.sendDebugCommand(command);
    }

    /**
     * Get last exception
     */
    getLastException(): { id: string; description: string; message: string; type: string } {
        return this.lastException || {
            id: 'UNKNOWN',
            description: 'Unknown error',
            message: 'No exception information available',
            type: 'Unknown'
        };
    }

    /**
     * Get breakpoint locations for a source range
     */
    getBreakpointLocations(file: string, startLine: number, endLine?: number): BreakpointLocation[] {
        const locations: BreakpointLocation[] = [];
        const end = endLine || startLine;

        // Find executable lines (DATA steps, macro calls, etc.)
        for (let line = startLine; line <= end && line <= this.sourceLines.length; line++) {
            const sourceLine = this.sourceLines[line - 1];
            if (this.isExecutableLine(sourceLine)) {
                locations.push({ line });
            }
        }

        return locations;
    }

    /**
     * Check if a line is executable (can have breakpoint)
     */
    private isExecutableLine(line: string): boolean {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            return false;
        }
        // SAS statements that can be breakpoints
        return /^(data|set|input|if|else|do|end|put|file|infile|%|call|output|delete|stop|return)/i.test(trimmed);
    }

    /**
     * Terminate the debugging session
     */
    terminate(): void {
        if (this.connection) {
            if (this.isPaused) {
                this.sendDebugCommand('QUIT');
            }
            this.connection.disconnect();
        }
        this.isRunning = false;
        this.isPaused = false;
        this.emit('end');
    }
}

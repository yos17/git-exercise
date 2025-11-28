import { EventEmitter } from 'events';

export interface MacroStatement {
    line: number;
    text: string;
    type: 'assignment' | 'call' | 'conditional' | 'loop' | 'output' | 'definition' | 'end' | 'other';
    macroName?: string;
}

interface MacroBreakpoint {
    id: number;
    line: number;
    condition?: string;
    hitCount: number;
    enabled: boolean;
}

interface MacroContext {
    name: string;
    line: number;
    localVars: Map<string, string>;
}

type StepMode = 'continue' | 'stepOver' | 'stepInto' | 'stepOut';

/**
 * IOM-based Macro Debugger
 *
 * Provides true step-through debugging for SAS macros by:
 * 1. Parsing macro code into individual statements
 * 2. Submitting each statement via IOM LanguageService
 * 3. Pausing between statements for step-through control
 * 4. Tracking macro variable values and call stack
 */
export class IOMacroDebugger extends EventEmitter {
    private static BREAKPOINT_ID = 1;

    private statements: MacroStatement[] = [];
    private currentStatementIndex: number = 0;
    private breakpoints: Map<number, MacroBreakpoint> = new Map();
    private macroContextStack: MacroContext[] = [];
    private globalMacroVars: Map<string, string> = new Map();

    private isRunning: boolean = false;
    private isPaused: boolean = false;
    private stepMode: StepMode = 'continue';
    private stepOutTargetDepth: number = 0;

    private submitCallback: ((code: string) => Promise<{ log: string; output: string }>) | null = null;

    setSubmitCallback(callback: (code: string) => Promise<{ log: string; output: string }>): void {
        this.submitCallback = callback;
    }

    parseSource(source: string): void {
        this.statements = [];
        const lines = source.split('\n');

        let inMacro = false;
        let currentMacroName = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            const lineNum = i + 1;

            if (!trimmedLine || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
                continue;
            }

            const statement = this.parseStatement(trimmedLine, lineNum, inMacro, currentMacroName);

            if (statement) {
                if (statement.type === 'definition') {
                    inMacro = true;
                    currentMacroName = statement.macroName || '';
                } else if (statement.type === 'end' && trimmedLine.toUpperCase().startsWith('%MEND')) {
                    inMacro = false;
                    currentMacroName = '';
                }

                this.statements.push(statement);
            }
        }
    }

    private parseStatement(line: string, lineNum: number, inMacro: boolean, macroName: string): MacroStatement | null {
        const upperLine = line.toUpperCase();

        // %LET assignment
        if (upperLine.startsWith('%LET ')) {
            return { line: lineNum, text: line, type: 'assignment' };
        }

        // %MACRO definition
        if (upperLine.startsWith('%MACRO ')) {
            const match = line.match(/%macro\s+(\w+)/i);
            return {
                line: lineNum,
                text: line,
                type: 'definition',
                macroName: match ? match[1] : undefined
            };
        }

        // %MEND
        if (upperLine.startsWith('%MEND')) {
            return { line: lineNum, text: line, type: 'end', macroName };
        }

        // %IF/%THEN/%ELSE
        if (upperLine.startsWith('%IF ') || upperLine.startsWith('%THEN ') ||
            upperLine.startsWith('%ELSE ') || upperLine === '%ELSE') {
            return { line: lineNum, text: line, type: 'conditional' };
        }

        // %DO loop
        if (upperLine.startsWith('%DO ') || upperLine === '%DO' ||
            upperLine.startsWith('%DO;') || upperLine === '%END' || upperLine.startsWith('%END;')) {
            return { line: lineNum, text: line, type: 'loop' };
        }

        // %PUT output
        if (upperLine.startsWith('%PUT ')) {
            return { line: lineNum, text: line, type: 'output' };
        }

        // Macro call
        if (line.match(/^%\w+/)) {
            const match = line.match(/^%(\w+)/);
            return {
                line: lineNum,
                text: line,
                type: 'call',
                macroName: match ? match[1] : undefined
            };
        }

        // Other statements that might contain macro references
        if (line.includes('&') || line.includes('%')) {
            return { line: lineNum, text: line, type: 'other' };
        }

        return null;
    }

    setBreakpoint(line: number, condition?: string): MacroBreakpoint {
        const bp: MacroBreakpoint = {
            id: IOMacroDebugger.BREAKPOINT_ID++,
            line,
            condition,
            hitCount: 0,
            enabled: true
        };
        this.breakpoints.set(bp.id, bp);
        return bp;
    }

    removeBreakpoint(id: number): boolean {
        return this.breakpoints.delete(id);
    }

    removeBreakpointByLine(line: number): boolean {
        for (const [id, bp] of this.breakpoints) {
            if (bp.line === line) {
                return this.breakpoints.delete(id);
            }
        }
        return false;
    }

    clearBreakpoints(): void {
        this.breakpoints.clear();
    }

    async start(stopOnEntry: boolean = true): Promise<void> {
        this.currentStatementIndex = 0;
        this.isRunning = true;
        this.macroContextStack = [];
        this.globalMacroVars.clear();

        await this.refreshGlobalMacroVars();

        if (stopOnEntry && this.statements.length > 0) {
            this.isPaused = true;
            this.emit('stopOnEntry', this.statements[0]);
        } else {
            await this.continue();
        }
    }

    async continue(): Promise<void> {
        this.stepMode = 'continue';
        this.isPaused = false;
        await this.executeUntilBreakpoint();
    }

    async stepOver(): Promise<void> {
        this.stepMode = 'stepOver';
        this.isPaused = false;

        const currentDepth = this.macroContextStack.length;
        await this.executeNextStatement();

        // If we stepped into a macro, continue until we're back at same depth
        while (this.isRunning && !this.isPaused && this.macroContextStack.length > currentDepth) {
            await this.executeNextStatement();
        }

        if (this.isRunning && !this.isPaused) {
            this.isPaused = true;
            this.emitStopEvent();
        }
    }

    async stepInto(): Promise<void> {
        this.stepMode = 'stepInto';
        this.isPaused = false;
        await this.executeNextStatement();

        if (this.isRunning && !this.isPaused) {
            this.isPaused = true;
            this.emitStopEvent();
        }
    }

    async stepOut(): Promise<void> {
        this.stepMode = 'stepOut';
        this.stepOutTargetDepth = Math.max(0, this.macroContextStack.length - 1);
        this.isPaused = false;

        while (this.isRunning && !this.isPaused &&
               this.macroContextStack.length > this.stepOutTargetDepth) {
            await this.executeNextStatement();
        }

        if (this.isRunning && !this.isPaused) {
            this.isPaused = true;
            this.emitStopEvent();
        }
    }

    private async executeUntilBreakpoint(): Promise<void> {
        while (this.isRunning && !this.isPaused &&
               this.currentStatementIndex < this.statements.length) {

            const stmt = this.statements[this.currentStatementIndex];

            // Check breakpoints
            if (this.shouldStopAtBreakpoint(stmt)) {
                this.isPaused = true;
                this.emit('stopOnBreakpoint', stmt);
                return;
            }

            await this.executeNextStatement();
        }

        if (this.currentStatementIndex >= this.statements.length) {
            this.isRunning = false;
            this.emit('end');
        }
    }

    private async executeNextStatement(): Promise<void> {
        if (this.currentStatementIndex >= this.statements.length) {
            this.isRunning = false;
            this.emit('end');
            return;
        }

        const stmt = this.statements[this.currentStatementIndex];
        this.emit('beforeExecute', stmt);

        try {
            await this.executeStatement(stmt);
            this.emit('afterExecute', stmt);
        } catch (error) {
            this.emit('error', stmt, error);
            this.isPaused = true;
            return;
        }

        this.currentStatementIndex++;
    }

    private async executeStatement(stmt: MacroStatement): Promise<void> {
        if (!this.submitCallback) {
            throw new Error('Submit callback not configured');
        }

        const result = await this.submitCallback(stmt.text);

        // Check for errors
        if (result.log.includes('ERROR:')) {
            const errorMatch = result.log.match(/ERROR:\s*(.+)/);
            throw new Error(errorMatch ? errorMatch[1] : 'SAS macro error');
        }

        // Update state based on statement type
        switch (stmt.type) {
            case 'definition':
                if (stmt.macroName) {
                    this.macroContextStack.push({
                        name: stmt.macroName,
                        line: stmt.line,
                        localVars: new Map()
                    });
                }
                break;

            case 'end':
                if (stmt.text.toUpperCase().includes('%MEND')) {
                    this.macroContextStack.pop();
                }
                break;

            case 'assignment':
                await this.refreshGlobalMacroVars();
                break;

            case 'call':
                // Macro call might define local variables
                await this.refreshGlobalMacroVars();
                break;

            case 'output':
                // %PUT - extract the output
                const putMatch = stmt.text.match(/%put\s+(.+);/i);
                if (putMatch) {
                    this.emit('output', putMatch[1], 'stdout');
                }
                break;
        }
    }

    private shouldStopAtBreakpoint(stmt: MacroStatement): boolean {
        for (const bp of this.breakpoints.values()) {
            if (!bp.enabled) continue;
            if (bp.line !== stmt.line) continue;

            bp.hitCount++;

            // Check condition
            if (bp.condition) {
                const conditionMet = this.evaluateCondition(bp.condition);
                if (!conditionMet) continue;
            }

            return true;
        }
        return false;
    }

    private evaluateCondition(condition: string): boolean {
        // Simple condition evaluation - check macro variable values
        const varMatch = condition.match(/&(\w+)\s*(=|!=|>|<|>=|<=)\s*(.+)/);
        if (varMatch) {
            const [, varName, operator, expected] = varMatch;
            const actual = this.globalMacroVars.get(varName.toUpperCase()) || '';

            switch (operator) {
                case '=': return actual === expected.trim();
                case '!=': return actual !== expected.trim();
                case '>': return parseFloat(actual) > parseFloat(expected);
                case '<': return parseFloat(actual) < parseFloat(expected);
                case '>=': return parseFloat(actual) >= parseFloat(expected);
                case '<=': return parseFloat(actual) <= parseFloat(expected);
            }
        }

        return true;
    }

    private emitStopEvent(): void {
        if (this.currentStatementIndex < this.statements.length) {
            this.emit('stopOnStep', this.statements[this.currentStatementIndex]);
        }
    }

    async refreshGlobalMacroVars(): Promise<void> {
        if (!this.submitCallback) return;

        try {
            const result = await this.submitCallback('%put _global_;');
            this.parseGlobalMacroVars(result.log);
        } catch {
            // Ignore errors during refresh
        }
    }

    private parseGlobalMacroVars(log: string): void {
        const lines = log.split('\n');

        for (const line of lines) {
            const match = line.match(/^GLOBAL\s+(\w+)\s+(.*)$/);
            if (match) {
                this.globalMacroVars.set(match[1].toUpperCase(), match[2].trim());
            }
        }
    }

    getGlobalMacroVars(): Map<string, string> {
        return new Map(this.globalMacroVars);
    }

    getLocalMacroVars(): Map<string, string> {
        if (this.macroContextStack.length > 0) {
            return this.macroContextStack[this.macroContextStack.length - 1].localVars;
        }
        return new Map();
    }

    getCallStack(): { name: string; line: number }[] {
        return [...this.macroContextStack];
    }

    getCurrentStatement(): MacroStatement | null {
        if (this.currentStatementIndex < this.statements.length) {
            return this.statements[this.currentStatementIndex];
        }
        return null;
    }
}

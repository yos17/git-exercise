import { EventEmitter } from 'events';

/**
 * Macro statement types for parsing
 */
export type MacroStatementType =
    | 'macro_def'      // %macro name
    | 'macro_end'      // %mend
    | 'macro_call'     // %macroname or %macroname()
    | 'macro_let'      // %let var = value
    | 'macro_if'       // %if condition %then
    | 'macro_else'     // %else
    | 'macro_do'       // %do / %do var = ...
    | 'macro_end_do'   // %end
    | 'macro_goto'     // %goto label
    | 'macro_label'    // %label:
    | 'macro_put'      // %put
    | 'macro_global'   // %global var
    | 'macro_local'    // %local var
    | 'macro_return'   // %return
    | 'macro_sysfunc'  // %sysfunc()
    | 'macro_eval'     // %eval() / %sysevalf()
    | 'sas_statement'  // Regular SAS statement
    | 'comment';       // * comment or /* comment */

/**
 * Parsed macro statement
 */
export interface MacroStatement {
    type: MacroStatementType;
    text: string;
    line: number;
    endLine: number;
    macroName?: string;      // For %macro, %mend, %call
    variableName?: string;   // For %let, %global, %local
    condition?: string;      // For %if
    parameters?: string[];   // For macro definitions and calls
}

/**
 * Macro execution context
 */
export interface MacroContext {
    name: string;
    startLine: number;
    localVars: Map<string, string>;
    parameters: Map<string, string>;
    callStack: string[];
}

/**
 * Macro breakpoint
 */
export interface MacroBreakpoint {
    id: number;
    line: number;
    macroName?: string;
    condition?: string;
    hitCount: number;
    enabled: boolean;
}

/**
 * IOM-based Macro Debugger
 *
 * Uses SAS IOM LanguageService for true step-through macro debugging
 * instead of just parsing MLOGIC/MPRINT output.
 *
 * Key approach:
 * 1. Parse macro code into individual statements
 * 2. Submit each statement via IOM with async mode
 * 3. Use LanguageService events to control execution
 * 4. Query macro variables between steps
 */
export class IOMacroDebugger extends EventEmitter {
    private statements: MacroStatement[] = [];
    private currentStatementIndex: number = 0;
    private breakpoints: Map<number, MacroBreakpoint> = new Map();
    private macroContextStack: MacroContext[] = [];
    private globalMacroVars: Map<string, string> = new Map();
    private isRunning: boolean = false;
    private isPaused: boolean = false;
    private stepMode: 'into' | 'over' | 'out' | 'continue' = 'continue';

    // IOM connection callback
    private submitCallback: ((code: string) => Promise<{ log: string; output: string }>) | null = null;

    private static BREAKPOINT_ID = 1;

    constructor() {
        super();
    }

    /**
     * Set the IOM submit callback for executing code
     */
    setSubmitCallback(callback: (code: string) => Promise<{ log: string; output: string }>): void {
        this.submitCallback = callback;
    }

    /**
     * Parse macro source code into executable statements
     */
    parseSource(source: string): MacroStatement[] {
        this.statements = [];
        const lines = source.split('\n');
        let currentLine = 0;
        let inMacroDef = false;
        let inComment = false;
        let statementBuffer = '';
        let statementStartLine = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            currentLine = i + 1;

            // Track multi-line comments
            if (line.includes('/*') && !line.includes('*/')) {
                inComment = true;
            }
            if (inComment && line.includes('*/')) {
                inComment = false;
                continue;
            }
            if (inComment) continue;

            // Skip line comments
            const trimmed = line.trim();
            if (trimmed.startsWith('*') && trimmed.endsWith(';')) {
                this.statements.push({
                    type: 'comment',
                    text: line,
                    line: currentLine,
                    endLine: currentLine
                });
                continue;
            }

            // Buffer statements until semicolon
            if (statementBuffer === '') {
                statementStartLine = currentLine;
            }
            statementBuffer += line + ' ';

            // Check for complete statement (ends with ;)
            if (trimmed.endsWith(';') || this.isCompleteStatement(statementBuffer)) {
                const statement = this.parseStatement(statementBuffer.trim(), statementStartLine, currentLine);
                if (statement) {
                    this.statements.push(statement);

                    // Track macro definitions
                    if (statement.type === 'macro_def') {
                        inMacroDef = true;
                    } else if (statement.type === 'macro_end') {
                        inMacroDef = false;
                    }
                }
                statementBuffer = '';
            }
        }

        return this.statements;
    }

    /**
     * Check if statement buffer contains a complete statement
     */
    private isCompleteStatement(buffer: string): boolean {
        const trimmed = buffer.trim();
        // Macro statements that don't need semicolons
        if (trimmed.match(/^%if\s+.+\s+%then\s*$/i)) return true;
        if (trimmed.match(/^%else\s*$/i)) return true;
        if (trimmed.match(/^%do\s*;?\s*$/i)) return true;
        if (trimmed.match(/^%end\s*;?\s*$/i)) return true;
        return trimmed.endsWith(';');
    }

    /**
     * Parse a single statement
     */
    private parseStatement(text: string, startLine: number, endLine: number): MacroStatement | null {
        const trimmed = text.trim();
        const upperText = trimmed.toUpperCase();

        // %macro definition
        let match = trimmed.match(/^%macro\s+(\w+)\s*(\([^)]*\))?\s*;?/i);
        if (match) {
            const params = match[2] ? this.parseParameters(match[2]) : [];
            return {
                type: 'macro_def',
                text: trimmed,
                line: startLine,
                endLine,
                macroName: match[1],
                parameters: params
            };
        }

        // %mend
        match = trimmed.match(/^%mend\s*(\w*)\s*;?/i);
        if (match) {
            return {
                type: 'macro_end',
                text: trimmed,
                line: startLine,
                endLine,
                macroName: match[1] || undefined
            };
        }

        // %let
        match = trimmed.match(/^%let\s+(\w+)\s*=\s*(.*);\s*$/i);
        if (match) {
            return {
                type: 'macro_let',
                text: trimmed,
                line: startLine,
                endLine,
                variableName: match[1]
            };
        }

        // %global
        match = trimmed.match(/^%global\s+(.+);\s*$/i);
        if (match) {
            return {
                type: 'macro_global',
                text: trimmed,
                line: startLine,
                endLine,
                variableName: match[1].trim()
            };
        }

        // %local
        match = trimmed.match(/^%local\s+(.+);\s*$/i);
        if (match) {
            return {
                type: 'macro_local',
                text: trimmed,
                line: startLine,
                endLine,
                variableName: match[1].trim()
            };
        }

        // %if
        match = trimmed.match(/^%if\s+(.+)\s+%then/i);
        if (match) {
            return {
                type: 'macro_if',
                text: trimmed,
                line: startLine,
                endLine,
                condition: match[1].trim()
            };
        }

        // %else
        if (upperText.startsWith('%ELSE')) {
            return {
                type: 'macro_else',
                text: trimmed,
                line: startLine,
                endLine
            };
        }

        // %do
        match = trimmed.match(/^%do\s*(\w+\s*=.+)?;?\s*$/i);
        if (match) {
            return {
                type: 'macro_do',
                text: trimmed,
                line: startLine,
                endLine,
                condition: match[1]?.trim()
            };
        }

        // %end
        if (upperText.match(/^%END\s*;?\s*$/)) {
            return {
                type: 'macro_end_do',
                text: trimmed,
                line: startLine,
                endLine
            };
        }

        // %put
        match = trimmed.match(/^%put\s+(.*);\s*$/i);
        if (match) {
            return {
                type: 'macro_put',
                text: trimmed,
                line: startLine,
                endLine
            };
        }

        // %goto
        match = trimmed.match(/^%goto\s+(\w+)\s*;?\s*$/i);
        if (match) {
            return {
                type: 'macro_goto',
                text: trimmed,
                line: startLine,
                endLine
            };
        }

        // %return
        if (upperText.match(/^%RETURN\s*;?\s*$/)) {
            return {
                type: 'macro_return',
                text: trimmed,
                line: startLine,
                endLine
            };
        }

        // Macro call: %macroname or %macroname()
        match = trimmed.match(/^%(\w+)\s*(\([^)]*\))?\s*;?\s*$/i);
        if (match && !this.isReservedMacroKeyword(match[1])) {
            return {
                type: 'macro_call',
                text: trimmed,
                line: startLine,
                endLine,
                macroName: match[1],
                parameters: match[2] ? this.parseCallParameters(match[2]) : []
            };
        }

        // Regular SAS statement
        return {
            type: 'sas_statement',
            text: trimmed,
            line: startLine,
            endLine
        };
    }

    /**
     * Check if word is a reserved macro keyword
     */
    private isReservedMacroKeyword(word: string): boolean {
        const reserved = [
            'macro', 'mend', 'let', 'if', 'then', 'else', 'do', 'end',
            'goto', 'global', 'local', 'return', 'put', 'sysfunc', 'eval',
            'sysevalf', 'str', 'nrstr', 'quote', 'bquote', 'superq', 'scan',
            'substr', 'index', 'length', 'upcase', 'lowcase', 'include'
        ];
        return reserved.includes(word.toLowerCase());
    }

    /**
     * Parse macro definition parameters
     */
    private parseParameters(paramStr: string): string[] {
        // Remove parentheses
        const inner = paramStr.slice(1, -1).trim();
        if (!inner) return [];

        return inner.split(',').map(p => p.trim().split('=')[0].trim());
    }

    /**
     * Parse macro call parameters
     */
    private parseCallParameters(paramStr: string): string[] {
        const inner = paramStr.slice(1, -1).trim();
        if (!inner) return [];

        return inner.split(',').map(p => p.trim());
    }

    /**
     * Set a breakpoint
     */
    setBreakpoint(line: number, macroName?: string, condition?: string): MacroBreakpoint {
        const bp: MacroBreakpoint = {
            id: IOMacroDebugger.BREAKPOINT_ID++,
            line,
            macroName,
            condition,
            hitCount: 0,
            enabled: true
        };
        this.breakpoints.set(bp.id, bp);
        return bp;
    }

    /**
     * Remove a breakpoint by ID
     */
    removeBreakpoint(id: number): boolean {
        return this.breakpoints.delete(id);
    }

    /**
     * Remove a breakpoint by line number
     */
    removeBreakpointByLine(line: number): boolean {
        for (const [id, bp] of this.breakpoints) {
            if (bp.line === line) {
                return this.breakpoints.delete(id);
            }
        }
        return false;
    }

    /**
     * Clear all breakpoints
     */
    clearBreakpoints(): void {
        this.breakpoints.clear();
    }

    /**
     * Start debugging from the beginning
     */
    async start(stopOnEntry: boolean = true): Promise<void> {
        this.currentStatementIndex = 0;
        this.isRunning = true;
        this.macroContextStack = [];
        this.globalMacroVars.clear();

        // Initialize global macro variables from SAS session
        await this.refreshGlobalMacroVars();

        if (stopOnEntry && this.statements.length > 0) {
            this.isPaused = true;
            this.emit('stopOnEntry', this.statements[0]);
        } else {
            await this.continue();
        }
    }

    /**
     * Continue execution until next breakpoint
     */
    async continue(): Promise<void> {
        this.stepMode = 'continue';
        this.isPaused = false;
        await this.executeUntilBreakpoint();
    }

    /**
     * Step to next statement (step over)
     */
    async stepOver(): Promise<void> {
        this.stepMode = 'over';
        await this.executeNextStatement();
    }

    /**
     * Step into macro call
     */
    async stepInto(): Promise<void> {
        this.stepMode = 'into';
        await this.executeNextStatement();
    }

    /**
     * Step out of current macro
     */
    async stepOut(): Promise<void> {
        this.stepMode = 'out';
        await this.executeUntilMacroEnd();
    }

    /**
     * Execute statements until a breakpoint is hit
     */
    private async executeUntilBreakpoint(): Promise<void> {
        while (this.currentStatementIndex < this.statements.length && !this.isPaused) {
            const stmt = this.statements[this.currentStatementIndex];

            // Check for breakpoint
            if (this.shouldBreak(stmt)) {
                this.isPaused = true;
                this.emit('stopOnBreakpoint', stmt);
                return;
            }

            await this.executeStatement(stmt);
            this.currentStatementIndex++;
        }

        if (this.currentStatementIndex >= this.statements.length) {
            this.isRunning = false;
            this.emit('end');
        }
    }

    /**
     * Execute the next statement and pause
     */
    private async executeNextStatement(): Promise<void> {
        if (this.currentStatementIndex >= this.statements.length) {
            this.isRunning = false;
            this.emit('end');
            return;
        }

        const stmt = this.statements[this.currentStatementIndex];
        await this.executeStatement(stmt);
        this.currentStatementIndex++;

        if (this.currentStatementIndex < this.statements.length) {
            this.isPaused = true;
            this.emit('stopOnStep', this.statements[this.currentStatementIndex]);
        } else {
            this.isRunning = false;
            this.emit('end');
        }
    }

    /**
     * Execute until end of current macro
     */
    private async executeUntilMacroEnd(): Promise<void> {
        const initialStackDepth = this.macroContextStack.length;

        while (this.currentStatementIndex < this.statements.length) {
            const stmt = this.statements[this.currentStatementIndex];
            await this.executeStatement(stmt);
            this.currentStatementIndex++;

            // Stop when we exit the macro we were in
            if (stmt.type === 'macro_end' && this.macroContextStack.length < initialStackDepth) {
                if (this.currentStatementIndex < this.statements.length) {
                    this.isPaused = true;
                    this.emit('stopOnStep', this.statements[this.currentStatementIndex]);
                }
                return;
            }
        }

        this.isRunning = false;
        this.emit('end');
    }

    /**
     * Execute a single statement via IOM
     */
    private async executeStatement(stmt: MacroStatement): Promise<void> {
        if (!this.submitCallback) {
            throw new Error('No IOM submit callback configured');
        }

        this.emit('beforeExecute', stmt);

        try {
            // Track macro context
            if (stmt.type === 'macro_def') {
                this.macroContextStack.push({
                    name: stmt.macroName || 'unknown',
                    startLine: stmt.line,
                    localVars: new Map(),
                    parameters: new Map(),
                    callStack: []
                });
            }

            // Submit statement to SAS via IOM
            const result = await this.submitCallback(stmt.text);

            // Parse result for macro variable changes
            this.parseExecutionResult(result.log, stmt);

            // Update context after execution
            if (stmt.type === 'macro_end') {
                this.macroContextStack.pop();
            }

            // Refresh macro variables after %let, %global, %local
            if (['macro_let', 'macro_global', 'macro_local'].includes(stmt.type)) {
                await this.refreshGlobalMacroVars();
            }

            this.emit('afterExecute', stmt, result);

        } catch (error) {
            this.emit('error', stmt, error);
            throw error;
        }
    }

    /**
     * Check if execution should break at this statement
     */
    private shouldBreak(stmt: MacroStatement): boolean {
        for (const bp of this.breakpoints.values()) {
            if (!bp.enabled) continue;

            // Line match
            if (stmt.line >= bp.line && stmt.endLine <= bp.line) {
                // Macro name filter
                if (bp.macroName) {
                    const currentMacro = this.macroContextStack[this.macroContextStack.length - 1];
                    if (!currentMacro || currentMacro.name !== bp.macroName) {
                        continue;
                    }
                }

                // Condition evaluation
                if (bp.condition) {
                    if (!this.evaluateCondition(bp.condition)) {
                        continue;
                    }
                }

                bp.hitCount++;
                return true;
            }
        }
        return false;
    }

    /**
     * Evaluate a breakpoint condition
     */
    private evaluateCondition(condition: string): boolean {
        // Simple condition evaluation
        // Supports: &var = value, &var > value, etc.
        const match = condition.match(/^&(\w+)\s*(=|>|<|>=|<=|!=)\s*(.+)$/);
        if (!match) return true;

        const [, varName, operator, value] = match;
        const varValue = this.globalMacroVars.get(varName.toUpperCase()) || '';

        switch (operator) {
            case '=': return varValue === value.trim();
            case '!=': return varValue !== value.trim();
            case '>': return parseFloat(varValue) > parseFloat(value);
            case '<': return parseFloat(varValue) < parseFloat(value);
            case '>=': return parseFloat(varValue) >= parseFloat(value);
            case '<=': return parseFloat(varValue) <= parseFloat(value);
            default: return true;
        }
    }

    /**
     * Parse execution result for macro variable updates
     */
    private parseExecutionResult(log: string, stmt: MacroStatement): void {
        // Parse SYMBOLGEN output
        const symbolgenPattern = /SYMBOLGEN:\s+Macro variable (\w+) resolves to (.+)/g;
        let match;
        while ((match = symbolgenPattern.exec(log)) !== null) {
            const [, varName, value] = match;
            this.globalMacroVars.set(varName.toUpperCase(), value);
        }

        // Parse %PUT output
        if (stmt.type === 'macro_put') {
            const putPattern = /^(.+)$/gm;
            while ((match = putPattern.exec(log)) !== null) {
                this.emit('output', match[1], 'stdout');
            }
        }

        // Parse errors
        if (log.includes('ERROR:')) {
            const errorPattern = /ERROR[^:]*:\s*(.+)/g;
            while ((match = errorPattern.exec(log)) !== null) {
                this.emit('output', match[0], 'stderr');
            }
        }
    }

    /**
     * Refresh global macro variables from SAS session
     */
    private async refreshGlobalMacroVars(): Promise<void> {
        if (!this.submitCallback) return;

        try {
            const result = await this.submitCallback('%put _global_;');

            // Parse global macro variables
            const varPattern = /^GLOBAL\s+(\w+)\s*(.*)$/gm;
            let match;
            while ((match = varPattern.exec(result.log)) !== null) {
                const [, name, value] = match;
                this.globalMacroVars.set(name.toUpperCase(), value.trim());
            }
        } catch {
            // Ignore errors in variable refresh
        }
    }

    /**
     * Get current macro variables
     */
    getGlobalMacroVars(): Map<string, string> {
        return new Map(this.globalMacroVars);
    }

    /**
     * Get local macro variables for current context
     */
    getLocalMacroVars(): Map<string, string> {
        const current = this.macroContextStack[this.macroContextStack.length - 1];
        return current ? new Map(current.localVars) : new Map();
    }

    /**
     * Get current statement
     */
    getCurrentStatement(): MacroStatement | null {
        return this.statements[this.currentStatementIndex] || null;
    }

    /**
     * Get current macro context
     */
    getCurrentMacroContext(): MacroContext | null {
        return this.macroContextStack[this.macroContextStack.length - 1] || null;
    }

    /**
     * Get call stack
     */
    getCallStack(): { name: string; line: number }[] {
        return this.macroContextStack.map(ctx => ({
            name: `%${ctx.name}`,
            line: ctx.startLine
        }));
    }

    /**
     * Get all parsed statements
     */
    getStatements(): MacroStatement[] {
        return [...this.statements];
    }

    /**
     * Stop debugging
     */
    stop(): void {
        this.isRunning = false;
        this.isPaused = false;
        this.emit('end');
    }
}

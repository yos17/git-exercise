import {
    LoggingDebugSession,
    InitializedEvent,
    StoppedEvent,
    BreakpointEvent,
    OutputEvent,
    TerminatedEvent,
    Thread,
    StackFrame,
    Scope,
    Source,
    Variable,
    Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { SASRuntime, SASBreakpoint, RuntimeVariable } from './sasRuntime';
import * as path from 'path';

/**
 * Launch request arguments for SAS debugging
 */
interface SASLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    connectionProfile: string;
    stopOnEntry: boolean;
    debugDataSteps: boolean;
    debugMacros: boolean;
}

/**
 * SAS Debug Adapter - Implements the Debug Adapter Protocol for SAS
 * Supports DATA step debugging and macro tracing
 */
export class SASDebugSession extends LoggingDebugSession {
    private static THREAD_ID = 1;
    private runtime: SASRuntime;
    private configurationDone = false;
    private currentFile: string = '';
    private sourceLines: string[] = [];

    constructor() {
        super('sas-debug.log');

        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);

        this.runtime = new SASRuntime();

        // Runtime events
        this.runtime.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnDataChange', (varName: string) => {
            this.sendEvent(new StoppedEvent('data breakpoint', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnException', (exception: string) => {
            this.sendEvent(new StoppedEvent('exception', SASDebugSession.THREAD_ID, exception));
        });

        this.runtime.on('breakpointValidated', (bp: SASBreakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', {
                verified: bp.verified,
                id: bp.id
            } as DebugProtocol.Breakpoint));
        });

        this.runtime.on('output', (text: string, category: string) => {
            const outputEvent = new OutputEvent(text + '\n', category);
            this.sendEvent(outputEvent);
        });

        this.runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    /**
     * Initialize the debug adapter
     */
    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        response.body = response.body || {};

        // Capabilities
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsStepBack = false;
        response.body.supportsDataBreakpoints = true;
        response.body.supportsCompletionsRequest = false;
        response.body.supportsCancelRequest = false;
        response.body.supportsBreakpointLocationsRequest = true;
        response.body.supportsStepInTargetsRequest = false;
        response.body.supportsExceptionFilterOptions = false;
        response.body.supportsExceptionInfoRequest = true;
        response.body.supportsSetVariable = true;
        response.body.supportsRestartFrame = false;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    /**
     * Configuration done - start debugging
     */
    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        super.configurationDoneRequest(response, args);
        this.configurationDone = true;
    }

    /**
     * Launch the debugger
     */
    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: SASLaunchRequestArguments
    ): Promise<void> {
        this.currentFile = args.program;

        try {
            // Initialize runtime with connection
            await this.runtime.initialize(args.connectionProfile);

            // Load the SAS program
            await this.runtime.loadProgram(args.program, {
                debugDataSteps: args.debugDataSteps,
                debugMacros: args.debugMacros
            });

            // Start execution
            if (args.stopOnEntry) {
                await this.runtime.start(true);
            } else {
                await this.runtime.start(false);
            }

            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, 1, `Failed to launch: ${error}`);
        }
    }

    /**
     * Set breakpoints in a source file
     */
    protected setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): void {
        const sourcePath = args.source.path || '';
        const clientLines = args.breakpoints || [];

        // Clear existing breakpoints for this file
        this.runtime.clearBreakpoints(sourcePath);

        // Set new breakpoints
        const breakpoints: DebugProtocol.Breakpoint[] = clientLines.map((bp, index) => {
            const sasBreakpoint = this.runtime.setBreakpoint(
                sourcePath,
                this.convertClientLineToDebugger(bp.line),
                bp.condition,
                bp.hitCondition,
                bp.logMessage
            );

            return {
                id: sasBreakpoint.id,
                verified: sasBreakpoint.verified,
                line: this.convertDebuggerLineToClient(sasBreakpoint.line),
                source: args.source
            } as DebugProtocol.Breakpoint;
        });

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    /**
     * Set data breakpoints (watch variables)
     */
    protected setDataBreakpointsRequest(
        response: DebugProtocol.SetDataBreakpointsResponse,
        args: DebugProtocol.SetDataBreakpointsArguments
    ): void {
        const breakpoints: DebugProtocol.Breakpoint[] = [];

        for (const dataBreakpoint of args.breakpoints) {
            const bp = this.runtime.setDataBreakpoint(dataBreakpoint.dataId);
            breakpoints.push({
                verified: bp.verified,
                id: bp.id
            });
        }

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    /**
     * Get threads (SAS is single-threaded)
     */
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(SASDebugSession.THREAD_ID, 'SAS Main Thread')
            ]
        };
        this.sendResponse(response);
    }

    /**
     * Get stack trace
     */
    protected stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): void {
        const startFrame = args.startFrame ?? 0;
        const maxLevels = args.levels ?? 1000;

        const stk = this.runtime.getStackTrace(startFrame, maxLevels);

        const frames: StackFrame[] = stk.frames.map((frame, index) => {
            const source = new Source(
                path.basename(frame.file),
                frame.file
            );

            return new StackFrame(
                frame.id,
                frame.name,
                source,
                this.convertDebuggerLineToClient(frame.line)
            );
        });

        response.body = {
            stackFrames: frames,
            totalFrames: stk.count
        };
        this.sendResponse(response);
    }

    /**
     * Get scopes for a stack frame
     */
    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): void {
        const scopes: Scope[] = [];

        // PDV (Program Data Vector) - DATA step variables
        scopes.push(new Scope('PDV Variables', 1000, false));

        // Macro Variables - Global
        scopes.push(new Scope('Global Macro Variables', 2000, false));

        // Macro Variables - Local
        scopes.push(new Scope('Local Macro Variables', 3000, false));

        // Automatic Variables
        scopes.push(new Scope('Automatic Variables', 4000, true));

        response.body = { scopes };
        this.sendResponse(response);
    }

    /**
     * Get variables for a scope
     */
    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        const variables: Variable[] = [];

        try {
            let runtimeVars: RuntimeVariable[] = [];

            switch (args.variablesReference) {
                case 1000: // PDV Variables
                    runtimeVars = await this.runtime.getPDVVariables();
                    break;
                case 2000: // Global Macro Variables
                    runtimeVars = await this.runtime.getGlobalMacroVariables();
                    break;
                case 3000: // Local Macro Variables
                    runtimeVars = await this.runtime.getLocalMacroVariables();
                    break;
                case 4000: // Automatic Variables
                    runtimeVars = await this.runtime.getAutomaticVariables();
                    break;
            }

            for (const v of runtimeVars) {
                variables.push({
                    name: v.name,
                    value: v.value,
                    type: v.type,
                    variablesReference: 0,
                    evaluateName: v.name
                });
            }
        } catch (error) {
            this.sendEvent(new OutputEvent(`Error getting variables: ${error}\n`, 'stderr'));
        }

        response.body = { variables };
        this.sendResponse(response);
    }

    /**
     * Continue execution
     */
    protected continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments
    ): void {
        this.runtime.continue();
        this.sendResponse(response);
    }

    /**
     * Step to next statement
     */
    protected nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments
    ): void {
        this.runtime.step();
        this.sendResponse(response);
    }

    /**
     * Step into
     */
    protected stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments
    ): void {
        this.runtime.stepIn();
        this.sendResponse(response);
    }

    /**
     * Step out
     */
    protected stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments
    ): void {
        this.runtime.stepOut();
        this.sendResponse(response);
    }

    /**
     * Pause execution
     */
    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments
    ): void {
        this.runtime.pause();
        this.sendResponse(response);
    }

    /**
     * Evaluate an expression
     */
    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        try {
            const result = await this.runtime.evaluate(args.expression, args.context);
            response.body = {
                result: result.value,
                type: result.type,
                variablesReference: 0
            };
        } catch (error) {
            response.body = {
                result: `Error: ${error}`,
                variablesReference: 0
            };
        }
        this.sendResponse(response);
    }

    /**
     * Set a variable value
     */
    protected async setVariableRequest(
        response: DebugProtocol.SetVariableResponse,
        args: DebugProtocol.SetVariableArguments
    ): Promise<void> {
        try {
            const newValue = await this.runtime.setVariable(args.name, args.value);
            response.body = {
                value: newValue,
                variablesReference: 0
            };
        } catch (error) {
            this.sendErrorResponse(response, 1, `Cannot set variable: ${error}`);
            return;
        }
        this.sendResponse(response);
    }

    /**
     * Disconnect from debugging
     */
    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments
    ): void {
        this.runtime.terminate();
        this.sendResponse(response);
    }

    /**
     * Get exception info
     */
    protected exceptionInfoRequest(
        response: DebugProtocol.ExceptionInfoResponse,
        args: DebugProtocol.ExceptionInfoArguments
    ): void {
        const exception = this.runtime.getLastException();
        response.body = {
            exceptionId: exception.id,
            description: exception.description,
            breakMode: 'always',
            details: {
                message: exception.message,
                typeName: exception.type
            }
        };
        this.sendResponse(response);
    }

    /**
     * Get breakpoint locations for a source range
     */
    protected breakpointLocationsRequest(
        response: DebugProtocol.BreakpointLocationsResponse,
        args: DebugProtocol.BreakpointLocationsArguments
    ): void {
        const locations = this.runtime.getBreakpointLocations(
            args.source.path || '',
            args.line,
            args.endLine
        );

        response.body = {
            breakpoints: locations.map(l => ({
                line: this.convertDebuggerLineToClient(l.line),
                column: l.column
            }))
        };
        this.sendResponse(response);
    }
}

// Run the debug adapter
SASDebugSession.run(SASDebugSession);

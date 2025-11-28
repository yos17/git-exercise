import {
    DebugSession,
    InitializedEvent,
    StoppedEvent,
    BreakpointEvent,
    OutputEvent,
    TerminatedEvent,
    Thread,
    StackFrame,
    Scope,
    Source,
    Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { SASRuntime, RuntimeVariable } from './sasRuntime';
import * as path from 'path';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    connection?: string;
    debugDataSteps?: boolean;
    debugMacros?: boolean;
    stopOnEntry?: boolean;
}

export class SASDebugSession extends DebugSession {
    private static THREAD_ID = 1;
    private runtime: SASRuntime;
    private variableHandles = new Map<number, string>();
    private nextVariableHandle = 1000;

    constructor() {
        super();

        this.runtime = new SASRuntime();

        // Set up runtime event handlers
        this.runtime.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnDataChange', () => {
            this.sendEvent(new StoppedEvent('data breakpoint', SASDebugSession.THREAD_ID));
        });

        this.runtime.on('stopOnException', (message: string) => {
            this.sendEvent(new StoppedEvent('exception', SASDebugSession.THREAD_ID, message));
        });

        this.runtime.on('breakpointValidated', (bp: any) => {
            this.sendEvent(new BreakpointEvent('changed', {
                verified: bp.verified,
                id: bp.id
            } as DebugProtocol.Breakpoint));
        });

        this.runtime.on('output', (text: string, category: string) => {
            const outputCategory = category === 'stderr' ? 'stderr' :
                                   category === 'console' ? 'console' : 'stdout';
            this.sendEvent(new OutputEvent(text + '\n', outputCategory));
        });

        this.runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

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
        response.body.supportsExceptionInfoRequest = true;
        response.body.supportsSetVariable = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: LaunchRequestArguments
    ): Promise<void> {
        try {
            // Initialize connection
            if (args.connection) {
                await this.runtime.initialize(args.connection);
            }

            // Load program
            await this.runtime.loadProgram(args.program, {
                debugDataSteps: args.debugDataSteps ?? true,
                debugMacros: args.debugMacros ?? true
            });

            // Start debugging
            await this.runtime.start(args.stopOnEntry ?? true);

            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 1,
                format: `Launch failed: ${error}`,
                showUser: true
            });
        }
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        super.configurationDoneRequest(response, args);
    }

    protected setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): void {
        const filePath = args.source.path || '';
        const clientBreakpoints = args.breakpoints || [];

        // Clear existing breakpoints for this file
        this.runtime.clearBreakpoints(filePath);

        // Set new breakpoints
        const breakpoints: DebugProtocol.Breakpoint[] = clientBreakpoints.map((bp) => {
            const sasBreakpoint = this.runtime.setBreakpoint(
                filePath,
                bp.line,
                bp.condition,
                bp.hitCondition,
                bp.logMessage
            );

            return {
                id: sasBreakpoint.id,
                verified: sasBreakpoint.verified,
                line: sasBreakpoint.line,
                source: args.source
            } as DebugProtocol.Breakpoint;
        });

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    protected setDataBreakpointsRequest(
        response: DebugProtocol.SetDataBreakpointsResponse,
        args: DebugProtocol.SetDataBreakpointsArguments
    ): void {
        const breakpoints: DebugProtocol.Breakpoint[] = [];

        for (const dbp of args.breakpoints) {
            const bp = this.runtime.setDataBreakpoint(dbp.dataId);
            breakpoints.push({
                id: bp.id,
                verified: bp.verified
            });
        }

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(SASDebugSession.THREAD_ID, 'SAS Session')
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): void {
        const startFrame = args.startFrame ?? 0;
        const maxLevels = args.levels ?? 100;

        const stack = this.runtime.getStackTrace(startFrame, maxLevels);

        response.body = {
            stackFrames: stack.frames.map((frame) => {
                return new StackFrame(
                    frame.id,
                    frame.name,
                    new Source(path.basename(frame.file), frame.file),
                    frame.line
                );
            }),
            totalFrames: stack.count
        };

        this.sendResponse(response);
    }

    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): void {
        const scopes: Scope[] = [];

        // PDV (Program Data Vector) - DATA step variables
        const pdvHandle = this.nextVariableHandle++;
        this.variableHandles.set(pdvHandle, 'pdv');
        scopes.push(new Scope('PDV (DATA Step Variables)', pdvHandle, false));

        // Macro Variables - Global
        const globalMacroHandle = this.nextVariableHandle++;
        this.variableHandles.set(globalMacroHandle, 'macro_global');
        scopes.push(new Scope('Global Macro Variables', globalMacroHandle, false));

        // Macro Variables - Local
        const localMacroHandle = this.nextVariableHandle++;
        this.variableHandles.set(localMacroHandle, 'macro_local');
        scopes.push(new Scope('Local Macro Variables', localMacroHandle, false));

        // Automatic Variables
        const autoHandle = this.nextVariableHandle++;
        this.variableHandles.set(autoHandle, 'automatic');
        scopes.push(new Scope('Automatic Variables', autoHandle, false));

        response.body = { scopes };
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        const scopeType = this.variableHandles.get(args.variablesReference);
        let variables: RuntimeVariable[] = [];

        switch (scopeType) {
            case 'pdv':
                variables = this.runtime.getPDVVariables();
                break;
            case 'macro_global':
                variables = this.runtime.getGlobalMacroVariables();
                break;
            case 'macro_local':
                variables = this.runtime.getLocalMacroVariables();
                break;
            case 'automatic':
                variables = this.runtime.getAutomaticVariables();
                break;
        }

        response.body = {
            variables: variables.map((v) => ({
                name: v.name,
                value: v.value,
                type: v.type,
                variablesReference: 0
            }))
        };

        this.sendResponse(response);
    }

    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments
    ): Promise<void> {
        await this.runtime.continue();
        this.sendResponse(response);
    }

    protected async nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments
    ): Promise<void> {
        await this.runtime.step();
        this.sendResponse(response);
    }

    protected async stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments
    ): Promise<void> {
        await this.runtime.stepIn();
        this.sendResponse(response);
    }

    protected async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments
    ): Promise<void> {
        await this.runtime.stepOut();
        this.sendResponse(response);
    }

    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments
    ): void {
        this.runtime.pause();
        this.sendResponse(response);
    }

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        let result: string;

        try {
            if (args.expression.startsWith('%')) {
                // Macro variable evaluation
                result = await this.runtime.evaluateMacroExpression(args.expression);
            } else {
                // PDV variable or expression
                result = await this.runtime.evaluateExpression(args.expression);
            }

            response.body = {
                result,
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

    protected async setVariableRequest(
        response: DebugProtocol.SetVariableResponse,
        args: DebugProtocol.SetVariableArguments
    ): Promise<void> {
        const scopeType = this.variableHandles.get(args.variablesReference);

        try {
            let newValue: string;

            if (scopeType === 'macro_global' || scopeType === 'macro_local') {
                newValue = await this.runtime.setMacroVariable(args.name, args.value);
            } else {
                newValue = await this.runtime.setVariable(args.name, args.value);
            }

            response.body = { value: newValue };
        } catch (error) {
            response.body = { value: `Error: ${error}` };
        }

        this.sendResponse(response);
    }

    protected exceptionInfoRequest(
        response: DebugProtocol.ExceptionInfoResponse,
        args: DebugProtocol.ExceptionInfoArguments
    ): void {
        const exception = this.runtime.getLastException();

        if (exception) {
            response.body = {
                exceptionId: exception.id,
                description: exception.description,
                breakMode: 'always',
                details: {
                    message: exception.message,
                    typeName: exception.type
                }
            };
        }

        this.sendResponse(response);
    }

    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments
    ): void {
        this.runtime.terminate();
        this.sendResponse(response);
    }
}

// Start the debug adapter
DebugSession.run(SASDebugSession);

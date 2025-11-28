import * as vscode from 'vscode';

interface AIProvider {
    complete(prompt: string, systemPrompt: string): Promise<string>;
}

class AnthropicProvider implements AIProvider {
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
    }

    async complete(prompt: string, systemPrompt: string): Promise<string> {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json() as any;
        return data.content[0].text;
    }
}

class OpenAIProvider implements AIProvider {
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
    }

    async complete(prompt: string, systemPrompt: string): Promise<string> {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 4096
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json() as any;
        return data.choices[0].message.content;
    }
}

const SAS_SYSTEM_PROMPT = `You are an expert SAS programmer with deep knowledge of:
- DATA step programming (arrays, loops, retain, merge, set, output)
- SAS procedures (PROC SQL, PROC MEANS, PROC FREQ, PROC REG, PROC LOGISTIC, etc.)
- SAS Macro language (%macro, %let, %do, %if, macro functions)
- SAS/STAT, SAS/GRAPH, SAS/ETS procedures
- SAS performance optimization techniques
- SAS ODS (Output Delivery System)
- SAS formats, informats, and date/time handling

When explaining code, be concise but thorough.
When generating code, include comments and follow SAS best practices.
When optimizing, focus on both performance and readability.
When debugging, identify the root cause and suggest fixes.

Always format SAS code properly with indentation.`;

export class AIAssistant {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('SAS AI Assistant');
    }

    private getProvider(): AIProvider {
        const config = vscode.workspace.getConfiguration('sasStudioAI.ai');
        const providerType = config.get<string>('provider') || 'anthropic';
        const apiKey = config.get<string>('apiKey') || '';
        const model = config.get<string>('model') || 'claude-sonnet-4-20250514';

        if (!apiKey) {
            throw new Error('AI API key not configured. Go to Settings > SAS Studio AI > AI API Key');
        }

        switch (providerType) {
            case 'anthropic':
                return new AnthropicProvider(apiKey, model);
            case 'openai':
                return new OpenAIProvider(apiKey, model.includes('claude') ? 'gpt-4' : model);
            default:
                throw new Error(`Unknown AI provider: ${providerType}`);
        }
    }

    async explainCode(code: string): Promise<void> {
        await this.runWithProgress('Explaining SAS code...', async () => {
            const provider = this.getProvider();
            const prompt = `Please explain the following SAS code in detail:

\`\`\`sas
${code}
\`\`\`

Explain:
1. What this code does overall
2. Key steps and logic
3. Any important SAS-specific constructs used
4. Potential issues or improvements`;

            const response = await provider.complete(prompt, SAS_SYSTEM_PROMPT);
            this.showResult('Code Explanation', response);
        });
    }

    async generateCode(description: string): Promise<void> {
        await this.runWithProgress('Generating SAS code...', async () => {
            const provider = this.getProvider();
            const prompt = `Generate SAS code for the following requirement:

${description}

Requirements:
- Write clean, well-commented SAS code
- Follow SAS best practices
- Include error handling where appropriate
- Use efficient techniques`;

            const response = await provider.complete(prompt, SAS_SYSTEM_PROMPT);
            await this.insertCode(response);
        });
    }

    async optimizeCode(code: string): Promise<void> {
        await this.runWithProgress('Optimizing SAS code...', async () => {
            const provider = this.getProvider();
            const prompt = `Please optimize the following SAS code for better performance and readability:

\`\`\`sas
${code}
\`\`\`

Provide:
1. Optimized version of the code
2. Explanation of each optimization made
3. Expected performance improvements
4. Any trade-offs to consider`;

            const response = await provider.complete(prompt, SAS_SYSTEM_PROMPT);
            this.showResultWithOption('Code Optimization', response, 'Replace with Optimized Code');
        });
    }

    async debugError(errorLog: string, code: string): Promise<void> {
        await this.runWithProgress('Analyzing error...', async () => {
            const provider = this.getProvider();
            const prompt = `Help debug this SAS error:

Error/Log:
\`\`\`
${errorLog}
\`\`\`

${code ? `Related code:
\`\`\`sas
${code}
\`\`\`` : ''}

Please:
1. Identify the root cause of the error
2. Explain why this error occurs
3. Provide the corrected code
4. Suggest how to prevent similar errors`;

            const response = await provider.complete(prompt, SAS_SYSTEM_PROMPT);
            this.showResult('Debug Analysis', response);
        });
    }

    async suggestDataAnonymization(columns: { name: string; type: string }[]): Promise<string> {
        const provider = this.getProvider();
        const prompt = `Given these dataset columns, suggest appropriate anonymization methods:

${columns.map(c => `- ${c.name} (${c.type})`).join('\n')}

For each column that might contain sensitive data (PII), suggest:
1. Whether it should be anonymized
2. The best anonymization method (mask, shuffle, synthetic, noise)
3. Specific handling recommendations

Return as JSON:
{
  "columns": [
    {"name": "col1", "sensitive": true, "method": "mask", "recommendation": "..."},
    ...
  ]
}`;

        return await provider.complete(prompt, SAS_SYSTEM_PROMPT);
    }

    private async runWithProgress(message: string, task: () => Promise<void>): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: message,
                cancellable: false
            },
            task
        );
    }

    private showResult(title: string, content: string): void {
        // Create a webview panel to show formatted results
        const panel = vscode.window.createWebviewPanel(
            'sasAIResult',
            `SAS AI: ${title}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = this.getResultHtml(title, content);
    }

    private async showResultWithOption(title: string, content: string, actionLabel: string): Promise<void> {
        const panel = vscode.window.createWebviewPanel(
            'sasAIResult',
            `SAS AI: ${title}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = this.getResultHtml(title, content, actionLabel);

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'applyCode') {
                await this.insertCode(message.code);
            }
        });
    }

    private async insertCode(response: string): Promise<void> {
        // Extract code blocks from response
        const codeMatch = response.match(/```sas\n([\s\S]*?)```/);
        const code = codeMatch ? codeMatch[1] : response;

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const position = editor.selection.active;
            await editor.edit((editBuilder) => {
                editBuilder.insert(position, code);
            });
        } else {
            // Create new document with the code
            const doc = await vscode.workspace.openTextDocument({
                language: 'sas',
                content: code
            });
            await vscode.window.showTextDocument(doc);
        }
    }

    private getResultHtml(title: string, content: string, actionLabel?: string): string {
        // Convert markdown-like content to HTML
        const htmlContent = content
            .replace(/```sas\n([\s\S]*?)```/g, '<pre class="code sas">$1</pre>')
            .replace(/```([\s\S]*?)```/g, '<pre class="code">$1</pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/^\d+\.\s/gm, '<li>')
            .replace(/^-\s/gm, '<li>');

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        h1 {
            color: var(--vscode-textLink-foreground);
            border-bottom: 1px solid var(--vscode-textLink-foreground);
            padding-bottom: 10px;
        }
        pre.code {
            background: var(--vscode-textCodeBlock-background);
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        pre.code.sas {
            border-left: 3px solid #0066cc;
        }
        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 5px;
            border-radius: 3px;
        }
        .action-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 20px;
            border-radius: 3px;
            cursor: pointer;
            margin-top: 15px;
        }
        .action-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <div class="content">
        <p>${htmlContent}</p>
    </div>
    ${actionLabel ? `
    <button class="action-button" onclick="applyCode()">
        ${actionLabel}
    </button>
    <script>
        const vscode = acquireVsCodeApi();
        function applyCode() {
            const codeBlocks = document.querySelectorAll('pre.code.sas');
            if (codeBlocks.length > 0) {
                vscode.postMessage({
                    command: 'applyCode',
                    code: codeBlocks[0].textContent
                });
            }
        }
    </script>
    ` : ''}
</body>
</html>`;
    }
}

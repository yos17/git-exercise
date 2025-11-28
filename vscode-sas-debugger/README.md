# SAS Studio AI

A powerful VS Code extension for SAS programming with AI assistance, debugging, and **secure data anonymization**.

## Features

### AI-Powered SAS Development
- **Code Explanation**: Select code and get detailed explanations
- **Code Generation**: Describe what you need, AI writes the SAS code
- **Code Optimization**: Automatic performance improvements
- **Error Debugging**: AI analyzes errors and suggests fixes

### Debugging
- **DATA Step Debugger**: Step through DATA step execution
- **Macro Debugger (IOM)**: True step-through macro debugging via IOM
- **Breakpoints**: Line breakpoints with conditions
- **Variable Inspection**: View PDV, macro variables, automatic variables
- **Watch Variables**: Monitor variable changes

### Dataset Viewer
- **Browse datasets** with pagination and filtering
- **Sort** by any column
- **Export** to CSV, Excel, JSON

### Secure Data Anonymization
**Before copying data from SAS, randomize it to protect sensitive information:**
- **Synthetic Data**: Generate statistically similar fake data
- **Shuffle**: Randomly permute values within columns
- **Masking**: Replace sensitive patterns (SSN, email, phone, credit card)
- **Noise**: Add random perturbation to numeric values

---

## Installation on Mac

### Step 1: Prerequisites

```bash
# 1. Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Python 3
brew install python@3.11

# 3. Install Java (required for SASPy)
brew install openjdk@11

# Add Java to PATH
echo 'export PATH="/opt/homebrew/opt/openjdk@11/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 4. Install Node.js (for extension development)
brew install node
```

### Step 2: Install Python Dependencies

```bash
# Create virtual environment (recommended)
python3 -m venv ~/.venv/sas
source ~/.venv/sas/bin/activate

# Install SASPy
pip install saspy pandas

# For AI features (optional)
pip install anthropic openai
```

### Step 3: Install the VS Code Extension

```bash
# Navigate to the extension directory
cd /path/to/vscode-sas-debugger

# Install npm dependencies
npm install

# Compile the extension
npm run compile

# Package the extension
npx vsce package

# Install the extension
code --install-extension sas-studio-ai-1.0.0.vsix
```

**Or install directly in VS Code:**
1. Open VS Code
2. Go to Extensions (⌘+Shift+X)
3. Click "..." → "Install from VSIX..."
4. Select the `.vsix` file

### Step 4: Configure SAS Connection

#### Option A: SAS OnDemand for Academics (FREE)

1. **Create account** at https://welcome.oda.sas.com/
2. **Create authentication file**:

```bash
# Create ~/.authinfo file
echo "machine odaws01-usw2.oda.sas.com login YOUR_EMAIL password YOUR_PASSWORD" > ~/.authinfo

# Secure the file
chmod 600 ~/.authinfo
```

3. **Configure SASPy** - Create `~/.config/saspy/sascfg_personal.py`:

```python
SAS_config_names = ['oda']

oda = {
    'java': '/opt/homebrew/opt/openjdk@11/bin/java',
    'iomhost': 'odaws01-usw2.oda.sas.com',
    'iomport': 443,
    'authkey': 'oda',
    'encoding': 'utf-8'
}
```

4. **Connect in VS Code**:
   - Press ⌘+Shift+P
   - Type "SAS: Connect"
   - Select "SAS OnDemand for Academics"

#### Option B: SAS Viya

1. Get client credentials from your Viya admin
2. Add connection profile in VS Code settings:

```json
{
  "sasStudioAI.connections": [
    {
      "name": "My Viya Server",
      "type": "viya",
      "host": "your-viya-server.com",
      "clientId": "your-client-id",
      "clientSecret": "your-client-secret"
    }
  ]
}
```

#### Option C: SAS 9.4 (IOM)

```json
{
  "sasStudioAI.connections": [
    {
      "name": "SAS 9.4 Server",
      "type": "iom",
      "host": "sas-server.company.com",
      "port": 8591,
      "username": "your-username"
    }
  ]
}
```

### Step 5: Configure AI (Optional)

For AI features, add your API key:

1. **Anthropic (Claude)**:
```json
{
  "sasStudioAI.ai.provider": "anthropic",
  "sasStudioAI.ai.apiKey": "sk-ant-api-...",
  "sasStudioAI.ai.model": "claude-sonnet-4-20250514"
}
```

2. **OpenAI**:
```json
{
  "sasStudioAI.ai.provider": "openai",
  "sasStudioAI.ai.apiKey": "sk-...",
  "sasStudioAI.ai.model": "gpt-4"
}
```

---

## Usage

### Running SAS Code

1. Open a `.sas` file
2. Connect to SAS (⌘+Shift+P → "SAS: Connect")
3. Run code:
   - **Selected code**: Select and press ⌘+Enter or right-click → "SAS: Run Selected Code"
   - **Entire file**: ⌘+Shift+P → "SAS: Run Entire File"

### Debugging

1. Set breakpoints by clicking in the gutter
2. Press F5 or click "Run and Debug"
3. Use debug controls:
   - **Continue** (F5)
   - **Step Over** (F10)
   - **Step Into** (F11) - steps into macro calls
   - **Step Out** (Shift+F11)

### Viewing Datasets

1. In the SAS Libraries panel, expand a library
2. Click on a dataset to view
3. Use filter bar: `column = 'value'` or `column > 100`
4. Click column headers to sort

### Secure Data Export (Anonymization)

⚠️ **Important**: Always anonymize data before exporting to protect sensitive information.

1. Right-click on a dataset in Libraries panel
2. Select "Anonymize & Export Dataset"
3. Choose anonymization method:
   - **Synthetic**: Best for development/testing - creates fake data with similar statistics
   - **Shuffle**: Good for analysis - preserves individual values but breaks relationships
   - **Mask**: Protects PII patterns (SSN, emails, phones, credit cards)
   - **Noise**: Adds randomness to numbers while preserving trends
4. Select output format (CSV, Excel, JSON, or SAS dataset)

### AI Features

- **Explain Code**: Select code → Right-click → "SAS AI: Explain"
- **Generate Code**: ⌘+Shift+P → "SAS AI: Generate Code from Description"
- **Optimize Code**: Select code → Right-click → "SAS AI: Optimize"
- **Debug Error**: Copy error message → ⌘+Shift+P → "SAS AI: Help Debug Error"

---

## Keyboard Shortcuts

| Command | Mac | Windows |
|---------|-----|---------|
| Run Selected Code | ⌘+Enter | Ctrl+Enter |
| Connect to SAS | ⌘+Shift+P → Connect | Ctrl+Shift+P → Connect |
| Start Debugging | F5 | F5 |
| Step Over | F10 | F10 |
| Step Into | F11 | F11 |
| Step Out | ⇧+F11 | Shift+F11 |
| Toggle Breakpoint | F9 | F9 |

---

## Troubleshooting

### "SASPy not installed"
```bash
pip install saspy
```

### "Java not found"
```bash
# Mac
brew install openjdk@11
export JAVA_HOME=/opt/homebrew/opt/openjdk@11

# Verify
java -version
```

### "Connection failed to SODA"
1. Verify ~/.authinfo exists and has correct credentials
2. Check file permissions: `chmod 600 ~/.authinfo`
3. Verify email/password at https://welcome.oda.sas.com/

### "Cannot connect to SAS 9.4"
1. Ensure your server allows IOM connections
2. Check firewall allows port 8591
3. Verify Java is installed and in PATH

### Debugging not working
1. Ensure you're connected to SAS
2. Check that the file is saved
3. Verify breakpoints are set (red dots in gutter)

---

## Security Best Practices

1. **Never export raw production data** - Always use anonymization
2. **Use synthetic data for development** - Preserves statistics, protects privacy
3. **Store API keys securely** - Use VS Code's secret storage or environment variables
4. **Secure ~/.authinfo** - `chmod 600 ~/.authinfo`

---

## License

MIT License - See LICENSE file for details.

## Contributing

Contributions welcome! Please read CONTRIBUTING.md for guidelines.

## Support

- **Issues**: https://github.com/your-org/sas-studio-ai/issues
- **Discussions**: https://github.com/your-org/sas-studio-ai/discussions

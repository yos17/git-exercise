# SAS Debugger for VS Code

A Visual Studio Code extension for debugging SAS DATA steps and macros, with integrated dataset viewing capabilities. Inspired by Bayer's MACUMBA tool.

## Features

### DATA Step Debugging
- **Breakpoints**: Set breakpoints in DATA step code
- **Step Execution**: Step through DATA step statements one at a time
- **Variable Inspection**: View PDV (Program Data Vector) values at each step
- **Conditional Breakpoints**: Break when specific conditions are met
- **Watch Variables**: Monitor specific variables for changes

### Macro Debugging
- **MLOGIC Tracing**: See macro execution flow
- **MPRINT Output**: View generated SAS code
- **SYMBOLGEN**: Track macro variable resolution
- **Macro Variable Inspector**: View global and local macro variables

### Dataset Viewer
- **Browse Libraries**: Navigate SAS libraries and datasets
- **View Data**: Open datasets in a tabular view
- **Filter Data**: Apply WHERE clauses to filter rows
- **Sort Columns**: Click column headers to sort
- **Export**: Export data to CSV format

### Code Execution
- **Run Code**: Execute selected code or entire files
- **SAS Log**: Color-coded log output with ERROR/WARNING highlighting
- **Multiple Connections**: Support for SAS 9.4 (via SASPy/IOM) and SAS Viya

## Requirements

- **VS Code**: Version 1.85.0 or higher
- **Python 3.8+** with the following packages:
  - `saspy` - For SAS connection
  - `pyreadstat` (optional) - For reading local SAS7BDAT files
  - `pandas` (optional) - For data manipulation

### SAS Server Requirements
- **SAS 9.4** with Workspace Server for IOM connections
- **SAS Viya** for REST API connections
- **Local SAS** on Windows for direct execution

## Installation

1. Install the extension from VS Code Marketplace
2. Install Python dependencies:
   ```bash
   pip install saspy pyreadstat pandas
   ```
3. Configure SASPy (see [SASPy Configuration](https://sassoftware.github.io/saspy/configuration.html))

## Configuration

### Connection Profiles

Configure connection profiles in VS Code settings:

```json
{
  "sasDebugger.connectionProfiles": [
    {
      "name": "local",
      "type": "saspy",
      "sasPath": "/usr/local/SAS/SASFoundation/9.4/sas"
    },
    {
      "name": "server",
      "type": "iom",
      "host": "sas.example.com",
      "port": 8591
    },
    {
      "name": "viya",
      "type": "viya",
      "host": "viya.example.com"
    }
  ],
  "sasDebugger.defaultProfile": "local",
  "sasDebugger.pythonPath": "python3"
}
```

### Macro Debugging Options

```json
{
  "sasDebugger.macroDebugging.mlogic": true,
  "sasDebugger.macroDebugging.mprint": true,
  "sasDebugger.macroDebugging.symbolgen": true
}
```

## Usage

### Running Code

1. Open a `.sas` file
2. Use `Ctrl+Shift+R` (or `Cmd+Shift+R` on Mac) to run selected code
3. Use `Ctrl+Shift+F5` to run the entire file

### Debugging

1. Set breakpoints by clicking in the gutter
2. Press `F5` to start debugging
3. Use the debug toolbar for step/continue/stop
4. View variables in the Debug sidebar

### Debug Launch Configuration

Create a `launch.json` in your workspace:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "sas",
      "request": "launch",
      "name": "Debug SAS Program",
      "program": "${file}",
      "connectionProfile": "default",
      "stopOnEntry": true,
      "debugDataSteps": true,
      "debugMacros": true
    }
  ]
}
```

### Viewing Datasets

- Use Command Palette: "SAS: View Dataset"
- Enter `library.dataset` name (e.g., `work.mydata`)
- Or right-click a `.sas7bdat` file in Explorer

## Commands

| Command | Description |
|---------|-------------|
| `SAS: Connect to SAS Server` | Connect to configured SAS server |
| `SAS: Disconnect from SAS Server` | Disconnect current session |
| `SAS: Run Selected Code` | Execute selected SAS code |
| `SAS: Run Current File` | Execute entire file |
| `SAS: View Dataset` | Open dataset viewer |
| `SAS: Browse Libraries` | Show library browser |
| `SAS: Show Macro Variables` | Display macro variables |
| `SAS: Clear Log` | Clear the SAS log output |

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Ctrl+Shift+R` | Run selected code |
| `Ctrl+Shift+F5` | Run current file |
| `F5` | Start debugging |
| `F10` | Step over |
| `F11` | Step into |
| `Shift+F11` | Step out |
| `F9` | Toggle breakpoint |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension                         │
├─────────────────────────────────────────────────────────────┤
│  Editor │ Debug Controls │ Dataset Viewer │ Library Browser │
├─────────────────────────────────────────────────────────────┤
│                Debug Adapter Protocol (DAP)                  │
├─────────────────────────────────────────────────────────────┤
│                 SAS Connection Layer                         │
│    ┌──────────┐  ┌──────────┐  ┌──────────────────┐        │
│    │  SASPy   │  │   IOM    │  │  Viya REST API   │        │
│    │ (Python) │  │  (Java)  │  │    (HTTP)        │        │
│    └──────────┘  └──────────┘  └──────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

## Limitations

- **DATA Step Debugger**: Only works within DATA steps (not PROC SQL or PROC IML)
- **Macro Debugging**: Provides tracing via MLOGIC/MPRINT, not true step-through debugging
- **Viya**: Interactive debugging not supported on SAS Viya
- **Performance**: Large datasets may be slow to load in viewer

## Troubleshooting

### "SASPy not installed" Error
```bash
pip install saspy
```

### Connection Timeout
- Check firewall settings
- Verify SAS server is running
- Check credentials in connection profile

### No Breakpoints Hit
- Ensure code contains DATA steps
- Verify debugging is enabled in launch configuration
- Check that breakpoints are on executable lines

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.

## Acknowledgments

- Inspired by [MACUMBA](https://www.researchgate.net/publication/296482750_MACUMBA_-_a_modern_SAS_GUI_-_debugging_made_easy) by Michael Weiss (Bayer)
- Built with [SASPy](https://github.com/sassoftware/saspy)
- Uses [VS Code Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)

#!/usr/bin/env python3
"""
SASPy Bridge for VS Code SAS Debugger Extension

This script provides a bridge between the VS Code extension and SAS
using the SASPy library. It runs as a subprocess and communicates
via stdin/stdout using JSON messages.
"""

import sys
import json
import re
from typing import Dict, Any, Optional, List

# Try to import saspy, provide helpful error if not installed
try:
    import saspy
except ImportError:
    print(json.dumps({
        "error": "SASPy not installed. Install with: pip install saspy"
    }))
    print("__END_RESPONSE__")
    sys.exit(1)

# Try to import pyreadstat for local file reading
try:
    import pyreadstat
    HAS_PYREADSTAT = True
except ImportError:
    HAS_PYREADSTAT = False

# Try to import pandas
try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False


class SASPyBridge:
    """Bridge class for SAS communication via SASPy"""

    def __init__(self):
        self.sas: Optional[saspy.SASsession] = None
        self.debug_mode = False
        self.last_log = ""

    def connect(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Establish SAS connection"""
        try:
            # Build connection parameters
            params = {}

            if config.get('cfgname'):
                params['cfgname'] = config['cfgname']

            if config.get('sasPath'):
                params['saspath'] = config['sasPath']

            if config.get('host'):
                params['iomhost'] = config['host']

            if config.get('port'):
                params['iomport'] = config['port']

            # Start SAS session
            self.sas = saspy.SASsession(**params) if params else saspy.SASsession()

            return {
                "status": "connected",
                "message": f"Connected to SAS"
            }
        except Exception as e:
            return {
                "status": "error",
                "message": str(e)
            }

    def connect_oda(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Connect to SAS OnDemand for Academics (FREE!)

        Requirements:
        1. Free SODA account: https://welcome.oda.sas.com/
        2. Java 1.8.0_162 or higher
        3. ~/.authinfo file with: oda user YOUR_EMAIL password YOUR_PASSWORD

        Regions:
        - us1: US West (odaws01-usw2.oda.sas.com)
        - us2: US East (odaws01-use1.oda.sas.com)
        - eu1: EU West 1 (odaws01-euw1.oda.sas.com)
        - eu2: EU West 2 (odaws01-euw2.oda.sas.com)
        - ap1: Asia Pacific (odaws01-apse1.oda.sas.com)
        """
        try:
            servers = config.get('servers', [])
            port = config.get('port', 8591)
            region = config.get('region', 'us1')

            if not servers:
                return {
                    "status": "error",
                    "message": "No SODA servers specified"
                }

            # Check for authinfo file
            import os
            home = os.path.expanduser("~")
            authinfo_path = os.path.join(home, '.authinfo')
            if os.name == 'nt':  # Windows
                authinfo_path = os.path.join(home, '_authinfo')

            if not os.path.exists(authinfo_path):
                return {
                    "status": "error",
                    "message": f"""
Authentication file not found!

Please create {authinfo_path} with:
oda user YOUR_SODA_EMAIL password YOUR_SODA_PASSWORD

Get free account at: https://welcome.oda.sas.com/
"""
                }

            # Connect to SODA using IOM
            self.sas = saspy.SASsession(
                iomhost=servers,
                iomport=port,
                authkey='oda',
                encoding='utf-8'
            )

            return {
                "status": "connected",
                "message": f"Connected to SAS OnDemand for Academics ({region})"
            }

        except Exception as e:
            error_msg = str(e)

            # Provide helpful error messages
            if "encryption" in error_msg.lower():
                error_msg += "\n\nTip: Ensure Java 1.8.0_162 or higher is installed"
            elif "auth" in error_msg.lower():
                error_msg += "\n\nTip: Check your ~/.authinfo file has correct credentials"
            elif "connect" in error_msg.lower():
                error_msg += "\n\nTip: Check your SODA region matches your account"

            return {
                "status": "error",
                "message": error_msg
            }

    def disconnect(self) -> Dict[str, Any]:
        """Close SAS connection"""
        if self.sas:
            self.sas.endsas()
            self.sas = None
        return {"status": "disconnected"}

    def submit(self, code: str) -> Dict[str, Any]:
        """Submit SAS code and return results"""
        if not self.sas:
            return {"error": "Not connected to SAS"}

        try:
            # Submit code
            result = self.sas.submit(code)

            # Parse log for errors and warnings
            log = result.get('LOG', '')
            self.last_log = log

            errors = self._parse_errors(log)
            warnings = self._parse_warnings(log)

            return {
                "log": log,
                "output": result.get('LST', ''),
                "errors": errors,
                "warnings": warnings,
                "status": "error" if errors else "success"
            }
        except Exception as e:
            return {
                "error": str(e),
                "log": "",
                "output": "",
                "errors": [{"line": 0, "message": str(e)}],
                "warnings": [],
                "status": "error"
            }

    def submit_async(self, code: str) -> Dict[str, Any]:
        """Submit code asynchronously (returns immediately)"""
        # SASPy doesn't have built-in async support
        # For now, just submit synchronously
        return self.submit(code)

    def debug(self, command: str) -> Dict[str, Any]:
        """Send a debug command to SAS"""
        if not self.sas:
            return {"error": "Not connected to SAS"}

        try:
            # Debug commands are sent as regular submissions
            # The DATA step debugger interprets them
            result = self.sas.submit(command)
            return {
                "output": result.get('LOG', ''),
                "status": "success"
            }
        except Exception as e:
            return {
                "error": str(e),
                "status": "error"
            }

    def get_libraries(self) -> Dict[str, Any]:
        """Get list of available libraries"""
        if not self.sas:
            return {"error": "Not connected to SAS"}

        try:
            code = """
            proc sql noprint;
                create table _libs_ as
                select libname, path, engine, readonly
                from dictionary.libnames
                where libname not like 'SAS%';
            quit;
            """
            self.sas.submit(code)

            df = self.sas.sasdata2dataframe(table='_libs_', libref='WORK')

            libraries = []
            for _, row in df.iterrows():
                libraries.append({
                    "name": str(row.get('LIBNAME', '')).strip(),
                    "path": str(row.get('PATH', '')).strip(),
                    "engine": str(row.get('ENGINE', '')).strip(),
                    "readonly": str(row.get('READONLY', 'no')).lower() == 'yes'
                })

            return {"libraries": libraries}
        except Exception as e:
            return {"error": str(e), "libraries": []}

    def get_datasets(self, library: str) -> Dict[str, Any]:
        """Get datasets in a library"""
        if not self.sas:
            return {"error": "Not connected to SAS"}

        try:
            code = f"""
            proc sql noprint;
                create table _datasets_ as
                select memname, nobs, nvars, crdate, modate, memlabel
                from dictionary.tables
                where libname = '{library.upper()}' and memtype = 'DATA';
            quit;
            """
            self.sas.submit(code)

            df = self.sas.sasdata2dataframe(table='_datasets_', libref='WORK')

            datasets = []
            for _, row in df.iterrows():
                datasets.append({
                    "name": str(row.get('MEMNAME', '')).strip(),
                    "library": library.upper(),
                    "nobs": int(row.get('NOBS', 0)),
                    "nvars": int(row.get('NVARS', 0)),
                    "label": str(row.get('MEMLABEL', '')).strip()
                })

            return {"datasets": datasets}
        except Exception as e:
            return {"error": str(e), "datasets": []}

    def get_variables(self, library: str, dataset: str) -> Dict[str, Any]:
        """Get variable information for a dataset"""
        if not self.sas:
            return {"error": "Not connected to SAS"}

        try:
            code = f"""
            proc contents data={library}.{dataset} out=_vars_ noprint;
            run;
            """
            self.sas.submit(code)

            df = self.sas.sasdata2dataframe(table='_vars_', libref='WORK')

            variables = []
            for _, row in df.iterrows():
                var_type = 'character' if row.get('TYPE', 2) == 2 else 'numeric'
                variables.append({
                    "name": str(row.get('NAME', '')).strip(),
                    "type": var_type,
                    "length": int(row.get('LENGTH', 0)),
                    "format": str(row.get('FORMAT', '')).strip(),
                    "informat": str(row.get('INFORMAT', '')).strip(),
                    "label": str(row.get('LABEL', '')).strip()
                })

            return {"variables": variables}
        except Exception as e:
            return {"error": str(e), "variables": []}

    def get_data(self, library: str, dataset: str, options: Optional[Dict] = None) -> Dict[str, Any]:
        """Get data from a dataset"""
        if not self.sas:
            return {"error": "Not connected to SAS"}

        options = options or {}

        try:
            # Build dataset options
            ds_opts = []
            if options.get('firstObs'):
                ds_opts.append(f"firstobs={options['firstObs']}")
            if options.get('obs'):
                ds_opts.append(f"obs={options['obs']}")
            if options.get('keep'):
                ds_opts.append(f"keep={' '.join(options['keep'])}")
            if options.get('drop'):
                ds_opts.append(f"drop={' '.join(options['drop'])}")
            if options.get('where'):
                ds_opts.append(f"where=({options['where']})")

            ds_options = f"({' '.join(ds_opts)})" if ds_opts else ""

            # Get data
            df = self.sas.sasdata2dataframe(
                table=dataset,
                libref=library,
                dsopts=ds_options
            )

            # Get column info
            var_result = self.get_variables(library, dataset)
            columns = var_result.get('variables', [])

            # Convert to rows
            rows = df.values.tolist()

            return {
                "columns": columns,
                "rows": rows
            }
        except Exception as e:
            return {"error": str(e), "columns": [], "rows": []}

    def read_local_file(self, filepath: str, options: Optional[Dict] = None) -> Dict[str, Any]:
        """Read a local SAS7BDAT file using pyreadstat"""
        if not HAS_PYREADSTAT:
            return {"error": "pyreadstat not installed. Install with: pip install pyreadstat"}

        options = options or {}

        try:
            # Read with pyreadstat
            df, meta = pyreadstat.read_sas7bdat(
                filepath,
                usecols=options.get('keep'),
                row_limit=options.get('obs'),
                row_offset=options.get('firstObs', 1) - 1 if options.get('firstObs') else 0
            )

            # Build column info from metadata
            columns = []
            for i, col in enumerate(meta.column_names):
                var_type = 'character' if meta.variable_types.get(col) == 'STRING' else 'numeric'
                columns.append({
                    "name": col,
                    "type": var_type,
                    "length": int(meta.variable_storage_width.get(col, 0)),
                    "format": str(meta.variable_measure.get(col, '')),
                    "label": str(meta.column_labels[i] if i < len(meta.column_labels) else '')
                })

            # Convert to rows
            rows = df.values.tolist()

            return {
                "columns": columns,
                "rows": rows,
                "nobs": len(rows),
                "nvars": len(columns)
            }
        except Exception as e:
            return {"error": str(e), "columns": [], "rows": []}

    def _parse_errors(self, log: str) -> List[Dict[str, Any]]:
        """Parse ERROR messages from SAS log"""
        errors = []
        error_pattern = re.compile(r'ERROR(?:\s+\d+-\d+)?:\s*(.+?)(?=\n|$)', re.MULTILINE)
        line_pattern = re.compile(r'at line (\d+)')

        for match in error_pattern.finditer(log):
            message = match.group(1).strip()
            line_match = line_pattern.search(message)
            line = int(line_match.group(1)) if line_match else 0

            errors.append({
                "line": line,
                "message": message
            })

        return errors

    def _parse_warnings(self, log: str) -> List[str]:
        """Parse WARNING messages from SAS log"""
        warnings = []
        warning_pattern = re.compile(r'WARNING:\s*(.+?)(?=\n|$)', re.MULTILINE)

        for match in warning_pattern.finditer(log):
            warnings.append(match.group(1).strip())

        return warnings


def main():
    """Main loop - read commands from stdin, write results to stdout"""
    bridge = SASPyBridge()

    for line in sys.stdin:
        try:
            command = json.loads(line.strip())

            cmd_type = command.get('command', '')
            result = {}

            if cmd_type == 'connect':
                result = bridge.connect(command.get('config', {}))
            elif cmd_type == 'connect_oda':
                result = bridge.connect_oda(command.get('config', {}))
            elif cmd_type == 'disconnect':
                result = bridge.disconnect()
            elif cmd_type == 'submit':
                result = bridge.submit(command.get('code', ''))
            elif cmd_type == 'submit_async':
                result = bridge.submit_async(command.get('code', ''))
            elif cmd_type == 'debug':
                result = bridge.debug(command.get('debugCommand', ''))
            elif cmd_type == 'get_libraries':
                result = bridge.get_libraries()
            elif cmd_type == 'get_datasets':
                result = bridge.get_datasets(command.get('library', ''))
            elif cmd_type == 'get_variables':
                result = bridge.get_variables(
                    command.get('library', ''),
                    command.get('dataset', '')
                )
            elif cmd_type == 'get_data':
                result = bridge.get_data(
                    command.get('library', ''),
                    command.get('dataset', ''),
                    command.get('options')
                )
            elif cmd_type == 'read_local':
                result = bridge.read_local_file(
                    command.get('filepath', ''),
                    command.get('options')
                )
            else:
                result = {"error": f"Unknown command: {cmd_type}"}

            # Output result
            print(json.dumps(result))
            print("__END_RESPONSE__")
            sys.stdout.flush()

        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}))
            print("__END_RESPONSE__")
            sys.stdout.flush()
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            print("__END_RESPONSE__")
            sys.stdout.flush()


if __name__ == '__main__':
    main()

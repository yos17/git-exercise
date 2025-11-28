#!/usr/bin/env python3
"""
SAS Bridge - Python bridge for connecting VS Code to SAS
Supports: SASPy (IOM, SODA), SSH, REST API (Viya)
"""

import sys
import json
import os
from typing import Optional, Dict, Any, List

# Try to import saspy
try:
    import saspy
    HAS_SASPY = True
except ImportError:
    HAS_SASPY = False

# Try to import requests for Viya REST API
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False


class SASBridge:
    """Bridge class for SAS connections"""

    def __init__(self):
        self.sas: Optional[Any] = None
        self.connection_type: Optional[str] = None

    def connect(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Connect to SAS based on configuration"""
        conn_type = config.get('type', 'soda')
        self.connection_type = conn_type

        try:
            if conn_type == 'soda':
                return self._connect_soda(config)
            elif conn_type == 'iom':
                return self._connect_iom(config)
            elif conn_type == 'viya':
                return self._connect_viya(config)
            elif conn_type == 'ssh':
                return self._connect_ssh(config)
            else:
                return {'success': False, 'error': f'Unknown connection type: {conn_type}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def _connect_soda(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Connect to SAS OnDemand for Academics"""
        if not HAS_SASPY:
            return {'success': False, 'error': 'saspy not installed. Run: pip install saspy'}

        region = config.get('region', 'us')

        # SODA server mappings
        soda_servers = {
            'us': 'odaws01-usw2.oda.sas.com',
            'eu': 'odaws01-euw1.oda.sas.com',
            'ap': 'odaws01-apse1.oda.sas.com'
        }

        host = soda_servers.get(region, soda_servers['us'])

        # Check for authinfo file
        authinfo_path = os.path.expanduser('~/.authinfo')
        if not os.path.exists(authinfo_path):
            return {
                'success': False,
                'error': f'''
SODA authentication required. Create ~/.authinfo file with:

machine {host} login YOUR_EMAIL password YOUR_PASSWORD

Then run: chmod 600 ~/.authinfo

Get your credentials at: https://welcome.oda.sas.com/
'''
            }

        try:
            self.sas = saspy.SASsession(cfgname='oda')
            return {'success': True, 'message': f'Connected to SODA ({region})'}
        except Exception as e:
            # Try with explicit config
            try:
                sascfg = {
                    'java': '/usr/bin/java',
                    'iomhost': host,
                    'iomport': 443,
                    'authkey': 'oda',
                    'encoding': 'utf-8'
                }
                self.sas = saspy.SASsession(**sascfg)
                return {'success': True, 'message': f'Connected to SODA ({region})'}
            except Exception as e2:
                return {'success': False, 'error': str(e2)}

    def _connect_iom(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Connect via IOM (SAS 9.4)"""
        if not HAS_SASPY:
            return {'success': False, 'error': 'saspy not installed. Run: pip install saspy'}

        try:
            sascfg = {
                'java': config.get('java', '/usr/bin/java'),
                'iomhost': config.get('host'),
                'iomport': config.get('port', 8591),
                'encoding': 'utf-8'
            }

            if config.get('username'):
                sascfg['omruser'] = config['username']

            self.sas = saspy.SASsession(**sascfg)
            return {'success': True, 'message': f'Connected to IOM at {config.get("host")}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def _connect_viya(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Connect to SAS Viya via REST API"""
        if not HAS_REQUESTS:
            return {'success': False, 'error': 'requests not installed. Run: pip install requests'}

        try:
            host = config.get('host')
            client_id = config.get('clientId')
            client_secret = config.get('clientSecret')

            # Get access token
            token_url = f'https://{host}/SASLogon/oauth/token'
            response = requests.post(
                token_url,
                data={
                    'grant_type': 'client_credentials',
                    'client_id': client_id,
                    'client_secret': client_secret
                },
                verify=True
            )
            response.raise_for_status()

            self.access_token = response.json().get('access_token')
            self.viya_host = host

            return {'success': True, 'message': f'Connected to Viya at {host}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def _connect_ssh(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Connect via SSH"""
        if not HAS_SASPY:
            return {'success': False, 'error': 'saspy not installed. Run: pip install saspy'}

        try:
            sascfg = {
                'saspath': '/opt/sas/sas',  # Adjust for your server
                'ssh': config.get('host'),
                'encoding': 'utf-8'
            }

            self.sas = saspy.SASsession(**sascfg)
            return {'success': True, 'message': f'Connected via SSH to {config.get("host")}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def disconnect(self) -> Dict[str, Any]:
        """Disconnect from SAS"""
        try:
            if self.sas:
                self.sas.endsas()
                self.sas = None
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def submit(self, code: str) -> Dict[str, Any]:
        """Submit SAS code"""
        if not self.sas:
            return {'success': False, 'error': 'Not connected'}

        try:
            result = self.sas.submit(code)
            return {
                'success': True,
                'log': result.get('LOG', ''),
                'output': result.get('LST', '')
            }
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_libraries(self) -> Dict[str, Any]:
        """Get list of available libraries"""
        if not self.sas:
            return {'success': False, 'error': 'Not connected'}

        try:
            code = """
proc sql noprint;
    select distinct libname into :libs separated by '~'
    from dictionary.libnames
    where libname not in ('MAPS', 'MAPSGFK', 'MAPSSAS');
quit;
%put LIBRARIES=&libs;
"""
            result = self.sas.submit(code)
            log = result.get('LOG', '')

            libs = []
            for line in log.split('\n'):
                if 'LIBRARIES=' in line:
                    lib_str = line.split('LIBRARIES=')[1].strip()
                    libs = [{'name': lib.strip()} for lib in lib_str.split('~') if lib.strip()]
                    break

            return {'success': True, 'libraries': libs}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_datasets(self, libref: str) -> Dict[str, Any]:
        """Get datasets in a library"""
        if not self.sas:
            return {'success': False, 'error': 'Not connected'}

        try:
            code = f"""
proc sql noprint;
    select memname, nobs, nvar
    into :names separated by '~', :rows separated by '~', :cols separated by '~'
    from dictionary.tables
    where libname = '{libref.upper()}' and memtype = 'DATA';
quit;
%put DATASETS=&names;
%put ROWS=&rows;
%put COLS=&cols;
"""
            result = self.sas.submit(code)
            log = result.get('LOG', '')

            names = []
            rows = []
            cols = []

            for line in log.split('\n'):
                if 'DATASETS=' in line:
                    names = [n.strip() for n in line.split('DATASETS=')[1].strip().split('~') if n.strip()]
                elif 'ROWS=' in line:
                    rows = [r.strip() for r in line.split('ROWS=')[1].strip().split('~') if r.strip()]
                elif 'COLS=' in line:
                    cols = [c.strip() for c in line.split('COLS=')[1].strip().split('~') if c.strip()]

            datasets = []
            for i, name in enumerate(names):
                datasets.append({
                    'name': name,
                    'rows': int(rows[i]) if i < len(rows) and rows[i].isdigit() else 0,
                    'columns': int(cols[i]) if i < len(cols) and cols[i].isdigit() else 0
                })

            return {'success': True, 'datasets': datasets}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_data(self, libref: str, dataset: str, start: int = 0,
                 limit: int = 100, filter_clause: str = '') -> Dict[str, Any]:
        """Get data from a dataset"""
        if not self.sas:
            return {'success': False, 'error': 'Not connected'}

        try:
            # Get column info
            col_code = f"""
proc sql noprint;
    select name, type, length
    into :names separated by '~', :types separated by '~', :lengths separated by '~'
    from dictionary.columns
    where libname = '{libref.upper()}' and memname = '{dataset.upper()}';

    select count(*) into :totalrows from {libref}.{dataset};
quit;
%put COLNAMES=&names;
%put COLTYPES=&types;
%put TOTALROWS=&totalrows;
"""
            result = self.sas.submit(col_code)
            log = result.get('LOG', '')

            col_names = []
            col_types = []
            total_rows = 0

            for line in log.split('\n'):
                if 'COLNAMES=' in line:
                    col_names = [n.strip() for n in line.split('COLNAMES=')[1].strip().split('~') if n.strip()]
                elif 'COLTYPES=' in line:
                    col_types = [t.strip() for t in line.split('COLTYPES=')[1].strip().split('~') if t.strip()]
                elif 'TOTALROWS=' in line:
                    try:
                        total_rows = int(line.split('TOTALROWS=')[1].strip())
                    except:
                        total_rows = 0

            columns = [{'name': n, 'type': t} for n, t in zip(col_names, col_types)]

            # Get data using pandas if available
            try:
                df = self.sas.sd2df(f'{libref}.{dataset}')

                # Apply filter if provided
                if filter_clause:
                    # Simple filter parsing
                    try:
                        df = df.query(filter_clause.replace('=', '=='))
                    except:
                        pass

                # Apply pagination
                df_page = df.iloc[start:start + limit]
                data = df_page.values.tolist()

                return {
                    'success': True,
                    'columns': columns,
                    'data': data,
                    'totalRows': len(df)
                }
            except Exception as e:
                # Fallback: use PROC PRINT output parsing
                return {
                    'success': True,
                    'columns': columns,
                    'data': [],
                    'totalRows': total_rows,
                    'warning': 'pandas not available for data transfer'
                }

        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_macro_vars(self) -> Dict[str, Any]:
        """Get macro variables"""
        if not self.sas:
            return {'success': False, 'error': 'Not connected'}

        try:
            result = self.sas.submit('%put _all_;')
            log = result.get('LOG', '')

            variables = []
            for line in log.split('\n'):
                # Parse GLOBAL and AUTOMATIC macro vars
                match_global = None
                match_auto = None

                if line.startswith('GLOBAL '):
                    parts = line[7:].split(' ', 1)
                    if len(parts) >= 1:
                        name = parts[0]
                        value = parts[1] if len(parts) > 1 else ''
                        variables.append({'name': name, 'value': value.strip(), 'scope': 'global'})
                elif line.startswith('AUTOMATIC '):
                    parts = line[10:].split(' ', 1)
                    if len(parts) >= 1:
                        name = parts[0]
                        value = parts[1] if len(parts) > 1 else ''
                        variables.append({'name': name, 'value': value.strip(), 'scope': 'automatic'})

            return {'success': True, 'variables': variables}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def debug_command(self, command: str) -> Dict[str, Any]:
        """Send debug command"""
        if not self.sas:
            return {'success': False, 'error': 'Not connected'}

        try:
            # Wrap debug command
            code = f"DEBUG {command};"
            result = self.sas.submit(code)
            return {
                'success': True,
                'output': result.get('LOG', '')
            }
        except Exception as e:
            return {'success': False, 'error': str(e)}


def main():
    """Main entry point - JSON protocol over stdin/stdout"""
    bridge = SASBridge()

    # Send ready signal
    print(json.dumps({'type': 'ready'}))
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            request_id = request.get('requestId')
            command = request.get('command')

            result: Dict[str, Any] = {}

            if command == 'connect':
                result = bridge.connect(request)
            elif command == 'disconnect':
                result = bridge.disconnect()
            elif command == 'submit':
                result = bridge.submit(request.get('code', ''))
            elif command == 'get_libraries':
                result = bridge.get_libraries()
            elif command == 'get_datasets':
                result = bridge.get_datasets(request.get('libref', ''))
            elif command == 'get_data':
                result = bridge.get_data(
                    request.get('libref', ''),
                    request.get('dataset', ''),
                    request.get('start', 0),
                    request.get('limit', 100),
                    request.get('filter', '')
                )
            elif command == 'get_macro_vars':
                result = bridge.get_macro_vars()
            elif command == 'debug':
                result = bridge.debug_command(request.get('debugCommand', ''))
            else:
                result = {'success': False, 'error': f'Unknown command: {command}'}

            result['requestId'] = request_id
            print(json.dumps(result))
            sys.stdout.flush()

        except json.JSONDecodeError as e:
            print(json.dumps({'success': False, 'error': f'Invalid JSON: {e}'}))
            sys.stdout.flush()
        except Exception as e:
            print(json.dumps({'success': False, 'error': str(e)}))
            sys.stdout.flush()


if __name__ == '__main__':
    main()

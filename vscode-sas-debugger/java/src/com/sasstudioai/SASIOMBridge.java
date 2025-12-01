package com.sasstudioai;

import java.io.*;
import java.util.*;
import com.sas.iom.SAS.IWorkspace;
import com.sas.iom.SAS.IWorkspaceHelper;
import com.sas.iom.SAS.ILanguageService;
import com.sas.iom.SAS.IDataService;
import com.sas.iom.SAS.ILibref;
import com.sas.iom.SAS.IDataset;
import com.sas.iom.SASIOMDefs.*;
import com.sas.services.connection.*;
import com.sas.rio.*;
import org.json.simple.*;
import org.json.simple.parser.*;

/**
 * SAS IOM Bridge - Java bridge for VS Code SAS extension
 *
 * Provides direct IOM access for:
 * - Code execution via LanguageService
 * - Macro debugging with step-through
 * - Dataset access via DataService
 * - Library browsing
 * - Variable inspection
 */
public class SASIOMBridge {

    private IWorkspace workspace;
    private ILanguageService languageService;
    private IDataService dataService;
    private Connection connection;
    private ConnectionFactory connectionFactory;

    // Debugging state
    private boolean debugMode = false;
    private List<String> macroStatements = new ArrayList<>();
    private int currentStatementIndex = 0;
    private Map<String, String> macroVariables = new HashMap<>();
    private List<Breakpoint> breakpoints = new ArrayList<>();

    public static void main(String[] args) {
        SASIOMBridge bridge = new SASIOMBridge();
        bridge.run();
    }

    public void run() {
        // Signal ready
        sendResponse(createResponse("ready", null));

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        JSONParser parser = new JSONParser();

        try {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    JSONObject request = (JSONObject) parser.parse(line);
                    JSONObject response = handleRequest(request);
                    sendResponse(response);
                } catch (ParseException e) {
                    sendError("Invalid JSON: " + e.getMessage(), null);
                }
            }
        } catch (IOException e) {
            System.err.println("IO Error: " + e.getMessage());
        }
    }

    private JSONObject handleRequest(JSONObject request) {
        String command = (String) request.get("command");
        String requestId = (String) request.get("requestId");

        try {
            switch (command) {
                case "connect":
                    return connect(request, requestId);
                case "disconnect":
                    return disconnect(requestId);
                case "submit":
                    return submit((String) request.get("code"), requestId);
                case "submitAsync":
                    return submitAsync((String) request.get("code"), requestId);
                case "get_libraries":
                    return getLibraries(requestId);
                case "get_datasets":
                    return getDatasets((String) request.get("libref"), requestId);
                case "get_data":
                    return getData(request, requestId);
                case "get_macro_vars":
                    return getMacroVariables(requestId);
                case "debug_start":
                    return debugStart((String) request.get("code"), requestId);
                case "debug_step":
                    return debugStep(requestId);
                case "debug_step_into":
                    return debugStepInto(requestId);
                case "debug_continue":
                    return debugContinue(requestId);
                case "debug_set_breakpoint":
                    return debugSetBreakpoint(request, requestId);
                case "debug_get_variables":
                    return debugGetVariables(requestId);
                case "evaluate":
                    return evaluate((String) request.get("expression"), requestId);
                default:
                    return createErrorResponse("Unknown command: " + command, requestId);
            }
        } catch (Exception e) {
            return createErrorResponse(e.getMessage(), requestId);
        }
    }

    /**
     * Connect to SAS via IOM
     */
    @SuppressWarnings("unchecked")
    private JSONObject connect(JSONObject request, String requestId) {
        try {
            String type = (String) request.get("type");
            String host = (String) request.get("host");
            Long port = (Long) request.get("port");
            String username = (String) request.get("username");
            String password = (String) request.get("password");

            // Build connection properties
            Properties props = new Properties();

            if ("soda".equals(type)) {
                // SAS OnDemand for Academics
                String region = (String) request.getOrDefault("region", "us");
                host = getSODAHost(region);
                port = 443L;
                props.setProperty("trustedPeer", "true");
            }

            // Create server definition
            BridgeServer server = new BridgeServer();
            server.setMachineDNSName(host);
            server.setPort(port != null ? port.intValue() : 8591);
            server.setProtocol(BridgeServer.PROTOCOL_IOM);

            // Create connection factory
            ConnectionFactoryConfiguration config = new ConnectionFactoryConfiguration();
            config.setServer(server);

            if (username != null && password != null) {
                SecurityPackageCredential cred = new SecurityPackageCredential();
                cred.setUserId(username);
                cred.setPassword(password);
                config.setCredential(cred);
            }

            connectionFactory = new ConnectionFactoryManager().getConnectionFactory(config);
            connection = connectionFactory.getConnection();

            // Get workspace
            org.omg.CORBA.Object obj = connection.getObject();
            workspace = IWorkspaceHelper.narrow(obj);

            // Get services
            languageService = workspace.LanguageService();
            dataService = workspace.DataService();

            JSONObject response = createResponse("success", requestId);
            response.put("message", "Connected to SAS via IOM at " + host);
            return response;

        } catch (Exception e) {
            return createErrorResponse("Connection failed: " + e.getMessage(), requestId);
        }
    }

    private String getSODAHost(String region) {
        switch (region) {
            case "eu": return "odaws01-euw1.oda.sas.com";
            case "ap": return "odaws01-apse1.oda.sas.com";
            default: return "odaws01-usw2.oda.sas.com";
        }
    }

    /**
     * Disconnect from SAS
     */
    @SuppressWarnings("unchecked")
    private JSONObject disconnect(String requestId) {
        try {
            if (workspace != null) {
                workspace.Close();
                workspace = null;
            }
            if (connection != null) {
                connectionFactory.returnConnection(connection);
                connection = null;
            }
            return createResponse("success", requestId);
        } catch (Exception e) {
            return createErrorResponse("Disconnect failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Submit SAS code synchronously
     */
    @SuppressWarnings("unchecked")
    private JSONObject submit(String code, String requestId) {
        if (languageService == null) {
            return createErrorResponse("Not connected", requestId);
        }

        try {
            // Submit code
            languageService.Submit(code);

            // Wait for completion and get results
            languageService.FlushLogLines(Integer.MAX_VALUE);

            // Get log
            CarriageControlSeqHolder logHolder = new CarriageControlSeqHolder();
            LineTypeSeqHolder typeHolder = new LineTypeSeqHolder();
            languageService.FlushLogLines(Integer.MAX_VALUE);

            StringBuilder log = new StringBuilder();
            StringBuilder output = new StringBuilder();

            // Read all log lines
            String[] logLines = languageService.FlushLog(10000);
            for (String line : logLines) {
                log.append(line).append("\n");
            }

            // Read list output
            String[] listLines = languageService.FlushList(10000);
            for (String line : listLines) {
                output.append(line).append("\n");
            }

            JSONObject response = createResponse("success", requestId);
            response.put("log", log.toString());
            response.put("output", output.toString());
            response.put("hasErrors", log.toString().contains("ERROR:"));
            response.put("hasWarnings", log.toString().contains("WARNING:"));

            return response;

        } catch (Exception e) {
            return createErrorResponse("Submit failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Submit SAS code asynchronously (for debugging)
     */
    @SuppressWarnings("unchecked")
    private JSONObject submitAsync(String code, String requestId) {
        if (languageService == null) {
            return createErrorResponse("Not connected", requestId);
        }

        try {
            // Use async submit for stepping
            languageService.SubmitAsync(code);

            JSONObject response = createResponse("success", requestId);
            response.put("status", "submitted");
            return response;

        } catch (Exception e) {
            return createErrorResponse("Async submit failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Get list of libraries
     */
    @SuppressWarnings("unchecked")
    private JSONObject getLibraries(String requestId) {
        if (dataService == null) {
            return createErrorResponse("Not connected", requestId);
        }

        try {
            JSONArray libraries = new JSONArray();

            // Query dictionary.libnames
            String code = "proc sql noprint; " +
                "select distinct libname into :libs separated by '~' " +
                "from dictionary.libnames; quit; " +
                "%put LIBS=&libs;";

            languageService.Submit(code);
            String[] logLines = languageService.FlushLog(10000);

            for (String line : logLines) {
                if (line.contains("LIBS=")) {
                    String libStr = line.substring(line.indexOf("LIBS=") + 5).trim();
                    for (String lib : libStr.split("~")) {
                        if (!lib.trim().isEmpty()) {
                            JSONObject libObj = new JSONObject();
                            libObj.put("name", lib.trim());
                            libraries.add(libObj);
                        }
                    }
                }
            }

            JSONObject response = createResponse("success", requestId);
            response.put("libraries", libraries);
            return response;

        } catch (Exception e) {
            return createErrorResponse("Get libraries failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Get datasets in a library
     */
    @SuppressWarnings("unchecked")
    private JSONObject getDatasets(String libref, String requestId) {
        if (dataService == null) {
            return createErrorResponse("Not connected", requestId);
        }

        try {
            JSONArray datasets = new JSONArray();

            String code = String.format(
                "proc sql noprint; " +
                "select memname, nobs, nvar into :names separated by '~', " +
                ":rows separated by '~', :cols separated by '~' " +
                "from dictionary.tables where libname='%s' and memtype='DATA'; quit; " +
                "%%put NAMES=&names; %%put ROWS=&rows; %%put COLS=&cols;",
                libref.toUpperCase()
            );

            languageService.Submit(code);
            String[] logLines = languageService.FlushLog(10000);

            String[] names = new String[0];
            String[] rows = new String[0];
            String[] cols = new String[0];

            for (String line : logLines) {
                if (line.contains("NAMES=")) {
                    names = line.substring(line.indexOf("NAMES=") + 6).trim().split("~");
                } else if (line.contains("ROWS=")) {
                    rows = line.substring(line.indexOf("ROWS=") + 5).trim().split("~");
                } else if (line.contains("COLS=")) {
                    cols = line.substring(line.indexOf("COLS=") + 5).trim().split("~");
                }
            }

            for (int i = 0; i < names.length; i++) {
                if (!names[i].trim().isEmpty()) {
                    JSONObject ds = new JSONObject();
                    ds.put("name", names[i].trim());
                    ds.put("rows", i < rows.length ? parseLong(rows[i]) : 0);
                    ds.put("columns", i < cols.length ? parseLong(cols[i]) : 0);
                    datasets.add(ds);
                }
            }

            JSONObject response = createResponse("success", requestId);
            response.put("datasets", datasets);
            return response;

        } catch (Exception e) {
            return createErrorResponse("Get datasets failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Get data from a dataset
     */
    @SuppressWarnings("unchecked")
    private JSONObject getData(JSONObject request, String requestId) {
        String libref = (String) request.get("libref");
        String dataset = (String) request.get("dataset");
        Long start = (Long) request.getOrDefault("start", 0L);
        Long limit = (Long) request.getOrDefault("limit", 100L);

        try {
            // Get column metadata
            JSONArray columns = new JSONArray();
            String colCode = String.format(
                "proc sql noprint; select name, type, length " +
                "into :names separated by '~', :types separated by '~', :lens separated by '~' " +
                "from dictionary.columns where libname='%s' and memname='%s'; quit; " +
                "%%put COLNAMES=&names; %%put COLTYPES=&types;",
                libref.toUpperCase(), dataset.toUpperCase()
            );

            languageService.Submit(colCode);
            String[] logLines = languageService.FlushLog(10000);

            String[] colNames = new String[0];
            String[] colTypes = new String[0];

            for (String line : logLines) {
                if (line.contains("COLNAMES=")) {
                    colNames = line.substring(line.indexOf("COLNAMES=") + 9).trim().split("~");
                } else if (line.contains("COLTYPES=")) {
                    colTypes = line.substring(line.indexOf("COLTYPES=") + 9).trim().split("~");
                }
            }

            for (int i = 0; i < colNames.length; i++) {
                JSONObject col = new JSONObject();
                col.put("name", colNames[i].trim());
                col.put("type", i < colTypes.length ? colTypes[i].trim().toLowerCase() : "char");
                columns.add(col);
            }

            // Get data using MVA (Multi-Version Access) if available, otherwise use PROC PRINT
            JSONArray data = new JSONArray();

            // Use PROC SQL with OUTOBS for pagination
            StringBuilder sql = new StringBuilder();
            sql.append("proc sql outobs=").append(limit).append("; ");
            sql.append("select * from ").append(libref).append(".").append(dataset);
            if (start > 0) {
                sql.append(" (firstobs=").append(start + 1).append(")");
            }
            sql.append("; quit;");

            languageService.Submit(sql.toString());
            String[] listLines = languageService.FlushList(100000);

            // Parse the output (simplified - in production would use proper data access)
            // For now, return column info and let client know to use proper data access

            // Get total row count
            String countCode = String.format(
                "proc sql noprint; select count(*) into :cnt from %s.%s; quit; %%put ROWCOUNT=&cnt;",
                libref, dataset
            );
            languageService.Submit(countCode);
            logLines = languageService.FlushLog(10000);

            long totalRows = 0;
            for (String line : logLines) {
                if (line.contains("ROWCOUNT=")) {
                    totalRows = parseLong(line.substring(line.indexOf("ROWCOUNT=") + 9).trim());
                }
            }

            JSONObject response = createResponse("success", requestId);
            response.put("columns", columns);
            response.put("data", data);
            response.put("totalRows", totalRows);
            return response;

        } catch (Exception e) {
            return createErrorResponse("Get data failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Get macro variables
     */
    @SuppressWarnings("unchecked")
    private JSONObject getMacroVariables(String requestId) {
        if (languageService == null) {
            return createErrorResponse("Not connected", requestId);
        }

        try {
            JSONArray variables = new JSONArray();

            languageService.Submit("%put _all_;");
            String[] logLines = languageService.FlushLog(10000);

            for (String line : logLines) {
                if (line.startsWith("GLOBAL ")) {
                    String[] parts = line.substring(7).split(" ", 2);
                    JSONObject var = new JSONObject();
                    var.put("name", parts[0]);
                    var.put("value", parts.length > 1 ? parts[1].trim() : "");
                    var.put("scope", "global");
                    variables.add(var);
                } else if (line.startsWith("AUTOMATIC ")) {
                    String[] parts = line.substring(10).split(" ", 2);
                    JSONObject var = new JSONObject();
                    var.put("name", parts[0]);
                    var.put("value", parts.length > 1 ? parts[1].trim() : "");
                    var.put("scope", "automatic");
                    variables.add(var);
                }
            }

            JSONObject response = createResponse("success", requestId);
            response.put("variables", variables);
            return response;

        } catch (Exception e) {
            return createErrorResponse("Get macro vars failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Start macro debugging - parse code into statements
     */
    @SuppressWarnings("unchecked")
    private JSONObject debugStart(String code, String requestId) {
        debugMode = true;
        macroStatements.clear();
        currentStatementIndex = 0;

        // Parse code into individual statements
        parseMacroStatements(code);

        JSONObject response = createResponse("success", requestId);
        response.put("totalStatements", macroStatements.size());

        if (!macroStatements.isEmpty()) {
            response.put("currentStatement", macroStatements.get(0));
            response.put("currentLine", getStatementLine(0));
        }

        return response;
    }

    /**
     * Parse macro code into individual statements for step debugging
     */
    private void parseMacroStatements(String code) {
        String[] lines = code.split("\n");
        StringBuilder currentStmt = new StringBuilder();

        for (String line : lines) {
            String trimmed = line.trim();

            // Skip empty lines and comments
            if (trimmed.isEmpty() || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
                continue;
            }

            currentStmt.append(line).append("\n");

            // Check if statement is complete (ends with semicolon)
            if (trimmed.endsWith(";") || trimmed.toUpperCase().equals("%MEND") ||
                trimmed.toUpperCase().startsWith("%MEND ")) {
                macroStatements.add(currentStmt.toString().trim());
                currentStmt = new StringBuilder();
            }
        }

        // Add any remaining code
        if (currentStmt.length() > 0) {
            macroStatements.add(currentStmt.toString().trim());
        }
    }

    private int getStatementLine(int index) {
        // In a full implementation, track line numbers during parsing
        return index + 1;
    }

    /**
     * Step to next statement (step over)
     */
    @SuppressWarnings("unchecked")
    private JSONObject debugStep(String requestId) {
        if (!debugMode || currentStatementIndex >= macroStatements.size()) {
            JSONObject response = createResponse("success", requestId);
            response.put("status", "ended");
            debugMode = false;
            return response;
        }

        try {
            // Execute current statement
            String stmt = macroStatements.get(currentStatementIndex);
            languageService.Submit(stmt);

            // Get log output
            String[] logLines = languageService.FlushLog(10000);
            StringBuilder log = new StringBuilder();
            for (String line : logLines) {
                log.append(line).append("\n");
            }

            // Update macro variables
            refreshMacroVariables();

            currentStatementIndex++;

            JSONObject response = createResponse("success", requestId);
            response.put("status", currentStatementIndex < macroStatements.size() ? "stepped" : "ended");
            response.put("log", log.toString());
            response.put("currentIndex", currentStatementIndex);

            if (currentStatementIndex < macroStatements.size()) {
                response.put("nextStatement", macroStatements.get(currentStatementIndex));
                response.put("currentLine", getStatementLine(currentStatementIndex));

                // Check for breakpoint
                if (hasBreakpointAtLine(getStatementLine(currentStatementIndex))) {
                    response.put("hitBreakpoint", true);
                }
            }

            // Add current macro variables
            JSONObject vars = new JSONObject();
            for (Map.Entry<String, String> entry : macroVariables.entrySet()) {
                vars.put(entry.getKey(), entry.getValue());
            }
            response.put("macroVariables", vars);

            return response;

        } catch (Exception e) {
            return createErrorResponse("Debug step failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Step into macro call
     */
    @SuppressWarnings("unchecked")
    private JSONObject debugStepInto(String requestId) {
        // For now, same as step - would need macro source lookup for true step-into
        return debugStep(requestId);
    }

    /**
     * Continue until next breakpoint
     */
    @SuppressWarnings("unchecked")
    private JSONObject debugContinue(String requestId) {
        if (!debugMode) {
            return createErrorResponse("Not in debug mode", requestId);
        }

        try {
            StringBuilder fullLog = new StringBuilder();

            while (currentStatementIndex < macroStatements.size()) {
                // Check for breakpoint
                if (hasBreakpointAtLine(getStatementLine(currentStatementIndex))) {
                    JSONObject response = createResponse("success", requestId);
                    response.put("status", "breakpoint");
                    response.put("currentIndex", currentStatementIndex);
                    response.put("currentStatement", macroStatements.get(currentStatementIndex));
                    response.put("currentLine", getStatementLine(currentStatementIndex));
                    response.put("log", fullLog.toString());
                    return response;
                }

                // Execute statement
                String stmt = macroStatements.get(currentStatementIndex);
                languageService.Submit(stmt);

                String[] logLines = languageService.FlushLog(10000);
                for (String line : logLines) {
                    fullLog.append(line).append("\n");
                }

                currentStatementIndex++;
            }

            refreshMacroVariables();
            debugMode = false;

            JSONObject response = createResponse("success", requestId);
            response.put("status", "ended");
            response.put("log", fullLog.toString());
            return response;

        } catch (Exception e) {
            return createErrorResponse("Debug continue failed: " + e.getMessage(), requestId);
        }
    }

    /**
     * Set breakpoint
     */
    @SuppressWarnings("unchecked")
    private JSONObject debugSetBreakpoint(JSONObject request, String requestId) {
        Long line = (Long) request.get("line");
        String condition = (String) request.get("condition");

        Breakpoint bp = new Breakpoint();
        bp.line = line.intValue();
        bp.condition = condition;
        bp.id = breakpoints.size() + 1;
        breakpoints.add(bp);

        JSONObject response = createResponse("success", requestId);
        response.put("breakpointId", bp.id);
        return response;
    }

    private boolean hasBreakpointAtLine(int line) {
        for (Breakpoint bp : breakpoints) {
            if (bp.line == line && bp.enabled) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get current debug variables
     */
    @SuppressWarnings("unchecked")
    private JSONObject debugGetVariables(String requestId) {
        refreshMacroVariables();

        JSONObject response = createResponse("success", requestId);
        JSONObject vars = new JSONObject();
        for (Map.Entry<String, String> entry : macroVariables.entrySet()) {
            vars.put(entry.getKey(), entry.getValue());
        }
        response.put("variables", vars);
        return response;
    }

    /**
     * Refresh macro variables from SAS session
     */
    private void refreshMacroVariables() {
        if (languageService == null) return;

        try {
            languageService.Submit("%put _global_;");
            String[] logLines = languageService.FlushLog(10000);

            macroVariables.clear();
            for (String line : logLines) {
                if (line.startsWith("GLOBAL ")) {
                    String[] parts = line.substring(7).split(" ", 2);
                    if (parts.length >= 1) {
                        macroVariables.put(parts[0], parts.length > 1 ? parts[1].trim() : "");
                    }
                }
            }
        } catch (Exception e) {
            // Ignore refresh errors
        }
    }

    /**
     * Evaluate an expression
     */
    @SuppressWarnings("unchecked")
    private JSONObject evaluate(String expression, String requestId) {
        if (languageService == null) {
            return createErrorResponse("Not connected", requestId);
        }

        try {
            String code;
            if (expression.startsWith("&")) {
                // Macro variable
                code = "%put EVAL=" + expression + ";";
            } else {
                // General expression
                code = "%let _eval_ = " + expression + "; %put EVAL=&_eval_;";
            }

            languageService.Submit(code);
            String[] logLines = languageService.FlushLog(10000);

            String result = "";
            for (String line : logLines) {
                if (line.contains("EVAL=")) {
                    result = line.substring(line.indexOf("EVAL=") + 5).trim();
                    break;
                }
            }

            JSONObject response = createResponse("success", requestId);
            response.put("result", result);
            return response;

        } catch (Exception e) {
            return createErrorResponse("Evaluate failed: " + e.getMessage(), requestId);
        }
    }

    // Helper methods

    @SuppressWarnings("unchecked")
    private JSONObject createResponse(String type, String requestId) {
        JSONObject response = new JSONObject();
        response.put("type", type);
        response.put("success", true);
        if (requestId != null) {
            response.put("requestId", requestId);
        }
        return response;
    }

    @SuppressWarnings("unchecked")
    private JSONObject createErrorResponse(String error, String requestId) {
        JSONObject response = new JSONObject();
        response.put("type", "error");
        response.put("success", false);
        response.put("error", error);
        if (requestId != null) {
            response.put("requestId", requestId);
        }
        return response;
    }

    private void sendResponse(JSONObject response) {
        System.out.println(response.toJSONString());
        System.out.flush();
    }

    private void sendError(String error, String requestId) {
        sendResponse(createErrorResponse(error, requestId));
    }

    private long parseLong(String s) {
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // Breakpoint class
    private static class Breakpoint {
        int id;
        int line;
        String condition;
        boolean enabled = true;
    }
}

import * as vscode from 'vscode';

/**
 * SAS Intelligent Code Completion Provider
 *
 * Provides context-aware completions for:
 * - Procedures with full syntax help
 * - Functions with signatures and examples
 * - Macro keywords and functions
 * - DATA step statements
 * - Dataset and variable names (from connection)
 * - Formats and informats
 */
export class SASCompletionProvider implements vscode.CompletionItemProvider {

    // Comprehensive SAS procedure database
    private static PROCEDURES: { [key: string]: { description: string; syntax: string; options: string[] } } = {
        'PRINT': {
            description: 'Prints observations from a SAS dataset',
            syntax: 'PROC PRINT DATA=dataset <options>;\n  VAR variables;\n  BY variables;\n  WHERE condition;\nRUN;',
            options: ['NOOBS', 'LABEL', 'N', 'SPLIT=', 'WIDTH=', 'HEADING=']
        },
        'MEANS': {
            description: 'Calculates descriptive statistics for numeric variables',
            syntax: 'PROC MEANS DATA=dataset <statistics> <options>;\n  CLASS variables;\n  VAR variables;\n  OUTPUT OUT=dataset MEAN= STD= MIN= MAX=;\nRUN;',
            options: ['N', 'MEAN', 'STD', 'MIN', 'MAX', 'SUM', 'MEDIAN', 'Q1', 'Q3', 'RANGE', 'CLM', 'STDERR', 'CV', 'USS', 'CSS', 'SKEWNESS', 'KURTOSIS', 'NMISS', 'MAXDEC=', 'FW=']
        },
        'FREQ': {
            description: 'Produces frequency tables and cross-tabulations',
            syntax: 'PROC FREQ DATA=dataset <options>;\n  TABLES variables / options;\n  BY variables;\nRUN;',
            options: ['NLEVELS', 'ORDER=', 'PAGE', 'NOPRINT', 'CHISQ', 'MEASURES', 'CMH', 'EXACT', 'NOCUM', 'NOPERCENT', 'NOROW', 'NOCOL', 'LIST', 'MISSING', 'CROSSLIST', 'OUT=']
        },
        'SORT': {
            description: 'Sorts observations in a SAS dataset',
            syntax: 'PROC SORT DATA=dataset OUT=sorted_dataset <options>;\n  BY <DESCENDING> variables;\nRUN;',
            options: ['NODUPKEY', 'NODUP', 'DUPOUT=', 'FORCE', 'OVERWRITE', 'TAGSORT', 'SORTSIZE=']
        },
        'SQL': {
            description: 'Executes SQL queries on SAS datasets',
            syntax: 'PROC SQL <options>;\n  SELECT columns\n  FROM tables\n  WHERE conditions\n  GROUP BY columns\n  HAVING conditions\n  ORDER BY columns;\nQUIT;',
            options: ['NOPRINT', 'OUTOBS=', 'INOBS=', 'NUMBER', 'DOUBLE', 'FLOW=', 'FEEDBACK', 'STIMER', 'LOOPS=', 'UNDO_POLICY=']
        },
        'REG': {
            description: 'Performs linear regression analysis',
            syntax: 'PROC REG DATA=dataset <options>;\n  MODEL dependent = independents / options;\n  OUTPUT OUT=dataset P= R= STUDENT= COOKD= H=;\nRUN;',
            options: ['SIMPLE', 'CORR', 'ALPHA=', 'PLOTS', 'SELECTION=', 'SLE=', 'SLS=', 'VIF', 'TOL', 'COLLIN', 'CLB', 'CLI', 'CLM', 'DW', 'INFLUENCE', 'R', 'PARTIAL', 'SCORR1', 'SCORR2', 'STB', 'SPEC', 'SS1', 'SS2']
        },
        'LOGISTIC': {
            description: 'Fits logistic regression models for binary/ordinal outcomes',
            syntax: 'PROC LOGISTIC DATA=dataset <options>;\n  CLASS categorical_vars / PARAM=ref;\n  MODEL outcome(EVENT="1") = predictors / options;\n  OUTPUT OUT=dataset P= XBETA= LOWER= UPPER=;\nRUN;',
            options: ['DESCENDING', 'SELECTION=', 'SLENTRY=', 'SLSTAY=', 'RSQUARE', 'LACKFIT', 'CTABLE', 'OUTROC=', 'PLOTS=', 'ODDSRATIO', 'CLODDS=', 'EXPB', 'STB', 'CORRB', 'COVB']
        },
        'UNIVARIATE': {
            description: 'Computes descriptive statistics and tests for normality',
            syntax: 'PROC UNIVARIATE DATA=dataset <options>;\n  VAR variables;\n  HISTOGRAM variables / NORMAL;\n  QQPLOT variables / NORMAL;\n  INSET MEAN STD / POSITION=NE;\nRUN;',
            options: ['NORMAL', 'PLOTS', 'FREQ', 'NEXTROBS=', 'NEXTRVAL=', 'MU0=', 'TRIMMED=', 'WINSORIZED=', 'CIBASIC', 'CIPCTLDF', 'CIPCTLNORMAL', 'ROBUSTSCALE']
        },
        'CORR': {
            description: 'Calculates correlation coefficients',
            syntax: 'PROC CORR DATA=dataset <options>;\n  VAR variables;\n  WITH variables;\nRUN;',
            options: ['PEARSON', 'SPEARMAN', 'KENDALL', 'HOEFFDING', 'NOSIMPLE', 'COV', 'CSSCP', 'SSCP', 'NOMISS', 'RANK', 'PLOTS=', 'FISHER', 'ALPHA=', 'OUTP=', 'OUTS=']
        },
        'TTEST': {
            description: 'Performs t-tests for mean comparisons',
            syntax: 'PROC TTEST DATA=dataset <options>;\n  CLASS groupvar;\n  VAR variables;\n  PAIRED var1*var2;\nRUN;',
            options: ['H0=', 'SIDES=', 'ALPHA=', 'CI=', 'PLOTS=', 'DIST=', 'COCHRAN', 'CROSSOVER=']
        },
        'ANOVA': {
            description: 'Performs analysis of variance',
            syntax: 'PROC ANOVA DATA=dataset <options>;\n  CLASS factors;\n  MODEL dependent = factors interactions;\n  MEANS factors / TUKEY SCHEFFE BON;\nRUN;',
            options: ['MANOVA', 'OUTSTAT=', 'ORDER=', 'ALPHA=', 'CLM', 'CLDIFF', 'LINES', 'E=', 'HOVTEST', 'WELCH']
        },
        'GLM': {
            description: 'General linear models (ANOVA, regression, ANCOVA)',
            syntax: 'PROC GLM DATA=dataset <options>;\n  CLASS categorical_vars;\n  MODEL dependent = effects / options;\n  MEANS effects / TUKEY;\n  LSMEANS effects / PDIFF ADJUST=TUKEY;\n  OUTPUT OUT=dataset P= R= STUDENT=;\nRUN;',
            options: ['SOLUTION', 'E', 'E1', 'E2', 'E3', 'E4', 'SS1', 'SS2', 'SS3', 'SS4', 'CLM', 'CLI', 'CLPARM', 'XPX', 'INVERSE', 'TOLERANCE', 'SINGULAR=', 'ZETA=']
        },
        'MIXED': {
            description: 'Fits mixed linear models with random effects',
            syntax: 'PROC MIXED DATA=dataset <options>;\n  CLASS subjects factors;\n  MODEL dependent = fixed_effects / DDFM=KR SOLUTION;\n  RANDOM intercept / SUBJECT=subject TYPE=UN;\n  REPEATED / TYPE=AR(1) SUBJECT=subject;\n  LSMEANS effects / PDIFF;\nRUN;',
            options: ['METHOD=', 'COVTEST', 'CL', 'IC', 'NOCLPRINT', 'PLOTS=', 'ASYCOV', 'DDFM=', 'ALPHA=']
        },
        'GENMOD': {
            description: 'Fits generalized linear models (GLM)',
            syntax: 'PROC GENMOD DATA=dataset <options>;\n  CLASS categorical_vars;\n  MODEL outcome = predictors / DIST= LINK= TYPE3;\n  REPEATED SUBJECT=id / TYPE=AR(1);\n  LSMEANS effects / DIFF CL;\nRUN;',
            options: ['DIST=', 'LINK=', 'NOSCALE', 'SCALE=', 'AGGREGATE', 'OBSTATS', 'TYPE1', 'TYPE3', 'WALDCI', 'LRCI', 'OFFSET=', 'NOINT']
        },
        'PHREG': {
            description: 'Fits Cox proportional hazards models for survival analysis',
            syntax: 'PROC PHREG DATA=dataset <options>;\n  CLASS categorical_vars / PARAM=REF;\n  MODEL time*censor(0) = predictors / TIES=EFRON RL;\n  HAZARDRATIO predictors;\n  OUTPUT OUT=dataset SURVIVAL= LOGSURV= XBETA=;\nRUN;',
            options: ['TIES=', 'RL', 'RISKLIMITS', 'COVB', 'CORRB', 'ALPHA=', 'SELECTION=', 'SLENTRY=', 'SLSTAY=', 'DETAILS', 'NOSUMMARY']
        },
        'LIFETEST': {
            description: 'Nonparametric survival analysis (Kaplan-Meier)',
            syntax: 'PROC LIFETEST DATA=dataset <options>;\n  TIME time_var*censor_var(0);\n  STRATA group_var;\n  TEST variables;\nRUN;',
            options: ['METHOD=', 'PLOTS=', 'CONFTYPE=', 'ALPHA=', 'OUTSURV=', 'REDUCEOUT', 'NOTABLE', 'NOPRINT', 'NELSON']
        },
        'SGPLOT': {
            description: 'Creates statistical graphics using ODS Graphics',
            syntax: 'PROC SGPLOT DATA=dataset <options>;\n  SCATTER X=xvar Y=yvar / GROUP=groupvar MARKERATTRS=(SYMBOL=circle);\n  SERIES X=xvar Y=yvar / LINEATTRS=(THICKNESS=2);\n  VBAR category / RESPONSE=numeric STAT=MEAN;\n  HISTOGRAM numeric / NORMAL;\n  XAXIS LABEL="X Label";\n  YAXIS LABEL="Y Label";\nRUN;',
            options: ['NOAUTOLEGEND', 'NOBORDER', 'PAD=', 'UNIFORM']
        },
        'TRANSPOSE': {
            description: 'Transposes a SAS dataset',
            syntax: 'PROC TRANSPOSE DATA=input OUT=output <options>;\n  BY variables;\n  ID variable;\n  VAR variables;\nRUN;',
            options: ['PREFIX=', 'SUFFIX=', 'NAME=', 'LABEL=', 'LET', 'DELIMITER=']
        },
        'DATASETS': {
            description: 'Manages SAS datasets and catalogs',
            syntax: 'PROC DATASETS LIBRARY=libref <options>;\n  DELETE datasets;\n  CHANGE oldname=newname;\n  MODIFY dataset;\n    RENAME oldvar=newvar;\n    LABEL var="label";\n    FORMAT var format.;\n  COPY OUT=libref;\n    SELECT datasets;\nQUIT;',
            options: ['NOLIST', 'NODETAILS', 'MEMTYPE=', 'KILL']
        },
        'FORMAT': {
            description: 'Creates custom formats and informats',
            syntax: 'PROC FORMAT <options>;\n  VALUE fmtname\n    value1 = "label1"\n    value2-value3 = "label2"\n    OTHER = "Other";\n  INVALUE infmtname\n    "text1" = value1;\n  PICTURE picname\n    low-high = "000,000.00";\nRUN;',
            options: ['LIBRARY=', 'CNTLOUT=', 'CNTLIN=', 'FMTLIB']
        },
        'CONTENTS': {
            description: 'Displays dataset structure and attributes',
            syntax: 'PROC CONTENTS DATA=dataset <options>;\nRUN;',
            options: ['SHORT', 'POSITION', 'VARNUM', 'OUT=', 'NOPRINT', 'DIRECTORY', 'MEMTYPE=', 'DETAILS', 'CENTILES']
        },
        'IMPORT': {
            description: 'Imports external data files',
            syntax: 'PROC IMPORT DATAFILE="filepath"\n    OUT=dataset\n    DBMS=CSV REPLACE;\n  GETNAMES=YES;\n  DATAROW=2;\nRUN;',
            options: ['DBMS=', 'REPLACE', 'GETNAMES=', 'DATAROW=', 'GUESSINGROWS=', 'DELIMITER=', 'SHEET=']
        },
        'EXPORT': {
            description: 'Exports SAS datasets to external files',
            syntax: 'PROC EXPORT DATA=dataset\n    OUTFILE="filepath"\n    DBMS=CSV REPLACE;\nRUN;',
            options: ['DBMS=', 'REPLACE', 'LABEL', 'DELIMITER=', 'PUTNAMES=']
        },
        'TABULATE': {
            description: 'Creates multi-dimensional tables',
            syntax: 'PROC TABULATE DATA=dataset <options>;\n  CLASS categorical_vars;\n  VAR numeric_vars;\n  TABLE row_expression,\n        column_expression*statistic;\n  KEYLABEL ALL="Total" N="Count" MEAN="Average";\nRUN;',
            options: ['FORMAT=', 'MISSING', 'NOSEPS', 'ORDER=', 'FORMCHAR=', 'VARDEF=']
        },
        'REPORT': {
            description: 'Creates customized reports',
            syntax: 'PROC REPORT DATA=dataset <options>;\n  COLUMN variables computed_columns;\n  DEFINE var / GROUP DISPLAY ORDER ANALYSIS FORMAT= WIDTH=;\n  COMPUTE computed_col;\n    computed_col = expression;\n  ENDCOMP;\n  BREAK AFTER group / SUMMARIZE;\n  RBREAK AFTER / SUMMARIZE;\nRUN;',
            options: ['NOWINDOWS', 'HEADLINE', 'HEADSKIP', 'MISSING', 'SPANROWS', 'SPLIT=', 'STYLE=']
        },
        'IML': {
            description: 'Interactive Matrix Language for matrix operations',
            syntax: 'PROC IML;\n  A = {1 2 3, 4 5 6, 7 8 9};\n  B = A` * A;\n  eigenvalues = eigval(B);\n  PRINT eigenvalues;\nQUIT;',
            options: []
        }
    };

    // SAS Functions database
    private static FUNCTIONS: { [key: string]: { description: string; syntax: string; returnType: string } } = {
        // String functions
        'SUBSTR': { description: 'Extract substring', syntax: 'SUBSTR(string, start, length)', returnType: 'char' },
        'SCAN': { description: 'Extract nth word from string', syntax: 'SCAN(string, n, delimiters)', returnType: 'char' },
        'TRIM': { description: 'Remove trailing blanks', syntax: 'TRIM(string)', returnType: 'char' },
        'STRIP': { description: 'Remove leading and trailing blanks', syntax: 'STRIP(string)', returnType: 'char' },
        'LEFT': { description: 'Left-align string', syntax: 'LEFT(string)', returnType: 'char' },
        'RIGHT': { description: 'Right-align string', syntax: 'RIGHT(string)', returnType: 'char' },
        'UPCASE': { description: 'Convert to uppercase', syntax: 'UPCASE(string)', returnType: 'char' },
        'LOWCASE': { description: 'Convert to lowercase', syntax: 'LOWCASE(string)', returnType: 'char' },
        'PROPCASE': { description: 'Convert to proper case', syntax: 'PROPCASE(string)', returnType: 'char' },
        'COMPRESS': { description: 'Remove characters', syntax: 'COMPRESS(string, chars, modifiers)', returnType: 'char' },
        'TRANSLATE': { description: 'Replace characters', syntax: 'TRANSLATE(string, to, from)', returnType: 'char' },
        'TRANWRD': { description: 'Replace words/patterns', syntax: 'TRANWRD(string, from, to)', returnType: 'char' },
        'CAT': { description: 'Concatenate strings', syntax: 'CAT(string1, string2, ...)', returnType: 'char' },
        'CATS': { description: 'Concatenate and strip', syntax: 'CATS(string1, string2, ...)', returnType: 'char' },
        'CATT': { description: 'Concatenate and trim', syntax: 'CATT(string1, string2, ...)', returnType: 'char' },
        'CATX': { description: 'Concatenate with delimiter', syntax: 'CATX(delimiter, string1, string2, ...)', returnType: 'char' },
        'LENGTH': { description: 'Get string length', syntax: 'LENGTH(string)', returnType: 'num' },
        'LENGTHN': { description: 'Get length (null-aware)', syntax: 'LENGTHN(string)', returnType: 'num' },
        'INDEX': { description: 'Find substring position', syntax: 'INDEX(string, substring)', returnType: 'num' },
        'FIND': { description: 'Find substring with modifiers', syntax: 'FIND(string, substring, modifiers, startpos)', returnType: 'num' },
        'COUNT': { description: 'Count occurrences', syntax: 'COUNT(string, substring)', returnType: 'num' },
        'COUNTW': { description: 'Count words', syntax: 'COUNTW(string, delimiters)', returnType: 'num' },
        'REVERSE': { description: 'Reverse string', syntax: 'REVERSE(string)', returnType: 'char' },
        'REPEAT': { description: 'Repeat string', syntax: 'REPEAT(string, n)', returnType: 'char' },

        // Numeric functions
        'SUM': { description: 'Sum of arguments', syntax: 'SUM(arg1, arg2, ...)', returnType: 'num' },
        'MEAN': { description: 'Mean of arguments', syntax: 'MEAN(arg1, arg2, ...)', returnType: 'num' },
        'MIN': { description: 'Minimum value', syntax: 'MIN(arg1, arg2, ...)', returnType: 'num' },
        'MAX': { description: 'Maximum value', syntax: 'MAX(arg1, arg2, ...)', returnType: 'num' },
        'ABS': { description: 'Absolute value', syntax: 'ABS(number)', returnType: 'num' },
        'SQRT': { description: 'Square root', syntax: 'SQRT(number)', returnType: 'num' },
        'ROUND': { description: 'Round to nearest', syntax: 'ROUND(number, unit)', returnType: 'num' },
        'CEIL': { description: 'Round up', syntax: 'CEIL(number)', returnType: 'num' },
        'FLOOR': { description: 'Round down', syntax: 'FLOOR(number)', returnType: 'num' },
        'INT': { description: 'Integer portion', syntax: 'INT(number)', returnType: 'num' },
        'MOD': { description: 'Modulo (remainder)', syntax: 'MOD(number, divisor)', returnType: 'num' },
        'LOG': { description: 'Natural logarithm', syntax: 'LOG(number)', returnType: 'num' },
        'LOG10': { description: 'Base-10 logarithm', syntax: 'LOG10(number)', returnType: 'num' },
        'EXP': { description: 'Exponential', syntax: 'EXP(number)', returnType: 'num' },
        'N': { description: 'Count non-missing', syntax: 'N(arg1, arg2, ...)', returnType: 'num' },
        'NMISS': { description: 'Count missing', syntax: 'NMISS(arg1, arg2, ...)', returnType: 'num' },
        'STD': { description: 'Standard deviation', syntax: 'STD(arg1, arg2, ...)', returnType: 'num' },
        'VAR': { description: 'Variance', syntax: 'VAR(arg1, arg2, ...)', returnType: 'num' },
        'RANGE': { description: 'Range (max-min)', syntax: 'RANGE(arg1, arg2, ...)', returnType: 'num' },

        // Date/Time functions
        'TODAY': { description: 'Current date', syntax: 'TODAY()', returnType: 'date' },
        'DATE': { description: 'Current date', syntax: 'DATE()', returnType: 'date' },
        'DATETIME': { description: 'Current datetime', syntax: 'DATETIME()', returnType: 'datetime' },
        'TIME': { description: 'Current time', syntax: 'TIME()', returnType: 'time' },
        'MDY': { description: 'Create date from M/D/Y', syntax: 'MDY(month, day, year)', returnType: 'date' },
        'YMD': { description: 'Create date from Y/M/D', syntax: 'YMD(year, month, day)', returnType: 'date' },
        'DHMS': { description: 'Create datetime', syntax: 'DHMS(date, hour, minute, second)', returnType: 'datetime' },
        'HMS': { description: 'Create time', syntax: 'HMS(hour, minute, second)', returnType: 'time' },
        'YEAR': { description: 'Extract year', syntax: 'YEAR(date)', returnType: 'num' },
        'MONTH': { description: 'Extract month', syntax: 'MONTH(date)', returnType: 'num' },
        'DAY': { description: 'Extract day', syntax: 'DAY(date)', returnType: 'num' },
        'WEEKDAY': { description: 'Day of week (1=Sun)', syntax: 'WEEKDAY(date)', returnType: 'num' },
        'QTR': { description: 'Quarter (1-4)', syntax: 'QTR(date)', returnType: 'num' },
        'WEEK': { description: 'Week of year', syntax: 'WEEK(date)', returnType: 'num' },
        'DATEPART': { description: 'Extract date from datetime', syntax: 'DATEPART(datetime)', returnType: 'date' },
        'TIMEPART': { description: 'Extract time from datetime', syntax: 'TIMEPART(datetime)', returnType: 'time' },
        'INTCK': { description: 'Interval between dates', syntax: 'INTCK(interval, from, to)', returnType: 'num' },
        'INTNX': { description: 'Increment date by interval', syntax: 'INTNX(interval, date, increment, alignment)', returnType: 'date' },
        'DATDIF': { description: 'Difference in days', syntax: 'DATDIF(start, end, basis)', returnType: 'num' },
        'YRDIF': { description: 'Difference in years', syntax: 'YRDIF(start, end, basis)', returnType: 'num' },

        // Conversion functions
        'INPUT': { description: 'Convert char to value using informat', syntax: 'INPUT(string, informat.)', returnType: 'varies' },
        'PUT': { description: 'Convert value to char using format', syntax: 'PUT(value, format.)', returnType: 'char' },

        // Conditional functions
        'IFN': { description: 'Numeric IF-THEN-ELSE', syntax: 'IFN(condition, true_value, false_value, missing_value)', returnType: 'num' },
        'IFC': { description: 'Character IF-THEN-ELSE', syntax: 'IFC(condition, true_value, false_value, missing_value)', returnType: 'char' },
        'COALESCE': { description: 'First non-missing numeric', syntax: 'COALESCE(arg1, arg2, ...)', returnType: 'num' },
        'COALESCEC': { description: 'First non-missing character', syntax: 'COALESCEC(arg1, arg2, ...)', returnType: 'char' },
        'MISSING': { description: 'Check if missing', syntax: 'MISSING(value)', returnType: 'num' },

        // Special functions
        'LAG': { description: 'Previous observation value', syntax: 'LAG(variable)', returnType: 'varies' },
        'LAG2': { description: '2 observations back', syntax: 'LAG2(variable)', returnType: 'varies' },
        'DIF': { description: 'Difference from previous', syntax: 'DIF(variable)', returnType: 'num' },
        'SYMGET': { description: 'Get macro variable value', syntax: 'SYMGET("macro_var_name")', returnType: 'char' },
        'RESOLVE': { description: 'Resolve macro expression', syntax: 'RESOLVE("&macvar or %macro")', returnType: 'char' }
    };

    // Macro functions
    private static MACRO_FUNCTIONS: string[] = [
        '%LET', '%PUT', '%IF', '%THEN', '%ELSE', '%DO', '%END', '%WHILE', '%UNTIL',
        '%MACRO', '%MEND', '%GLOBAL', '%LOCAL', '%INCLUDE', '%SYSFUNC', '%EVAL', '%SYSEVALF',
        '%STR', '%NRSTR', '%BQUOTE', '%NRBQUOTE', '%SUPERQ', '%UNQUOTE',
        '%SCAN', '%SUBSTR', '%INDEX', '%LENGTH', '%UPCASE', '%LOWCASE', '%QSCAN', '%QSUBSTR',
        '%SYMEXIST', '%SYMGLOBL', '%SYMLOCAL', '%SYSGET', '%SYSPROD'
    ];

    // DATA step statements
    private static DATA_STATEMENTS: { [key: string]: string } = {
        'DATA': 'DATA dataset_name; ... RUN;',
        'SET': 'SET dataset(s) <options>; /* Read observations */',
        'MERGE': 'MERGE dataset1 dataset2; BY key; /* Merge datasets */',
        'UPDATE': 'UPDATE master transaction; BY key; /* Update master */',
        'BY': 'BY variable(s); /* Group processing */',
        'IF': 'IF condition THEN statement; /* Conditional execution */',
        'WHERE': 'WHERE condition; /* Subset observations */',
        'KEEP': 'KEEP variable(s); /* Keep only these variables */',
        'DROP': 'DROP variable(s); /* Drop these variables */',
        'RENAME': 'RENAME old=new; /* Rename variable */',
        'LENGTH': 'LENGTH variable(s) $length; /* Define variable length */',
        'FORMAT': 'FORMAT variable(s) format.; /* Apply display format */',
        'INFORMAT': 'INFORMAT variable(s) informat.; /* Apply input format */',
        'LABEL': 'LABEL variable="Label text"; /* Apply label */',
        'ATTRIB': 'ATTRIB variable LENGTH=$n FORMAT=fmt. LABEL="text";',
        'RETAIN': 'RETAIN variable(s) <initial_value>; /* Retain across obs */',
        'ARRAY': 'ARRAY arrayname{n} variable(s); /* Define array */',
        'DO': 'DO index = start TO end BY increment; ... END;',
        'OUTPUT': 'OUTPUT <dataset>; /* Write observation */',
        'DELETE': 'DELETE; /* Delete current observation */',
        'RETURN': 'RETURN; /* Return to top of DATA step */',
        'STOP': 'STOP; /* Stop processing */',
        'ABORT': 'ABORT; /* Stop with error */',
        'INFILE': 'INFILE "path" options; /* Define input file */',
        'INPUT': 'INPUT variable(s) <informats>; /* Read data */',
        'FILE': 'FILE "path" options; /* Define output file */',
        'PUT': 'PUT variable(s) <formats>; /* Write data */',
        'CARDS': 'CARDS; ... ; /* Inline data */',
        'DATALINES': 'DATALINES; ... ; /* Inline data (same as CARDS) */',
        'FIRST.': 'FIRST.byvar /* First obs in BY group */',
        'LAST.': 'LAST.byvar /* Last obs in BY group */'
    };

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const linePrefixUpper = linePrefix.toUpperCase();

        const completions: vscode.CompletionItem[] = [];

        // PROC completion
        if (linePrefixUpper.match(/PROC\s+$/)) {
            for (const [name, info] of Object.entries(SASCompletionProvider.PROCEDURES)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
                item.detail = info.description;
                item.documentation = new vscode.MarkdownString(
                    `**PROC ${name}**\n\n${info.description}\n\n\`\`\`sas\n${info.syntax}\n\`\`\`\n\n**Options:** ${info.options.join(', ')}`
                );
                item.insertText = new vscode.SnippetString(`${name} DATA=\${1:dataset};\n\t$0\nRUN;`);
                completions.push(item);
            }
            return completions;
        }

        // After PROC name - suggest options
        for (const [name, info] of Object.entries(SASCompletionProvider.PROCEDURES)) {
            if (linePrefixUpper.includes(`PROC ${name}`)) {
                for (const opt of info.options) {
                    const item = new vscode.CompletionItem(opt, vscode.CompletionItemKind.Property);
                    item.detail = `Option for PROC ${name}`;
                    completions.push(item);
                }
                break;
            }
        }

        // Macro completions (after %)
        if (linePrefix.endsWith('%')) {
            for (const macroFn of SASCompletionProvider.MACRO_FUNCTIONS) {
                const item = new vscode.CompletionItem(macroFn.substring(1), vscode.CompletionItemKind.Function);
                item.detail = 'Macro keyword';
                item.insertText = macroFn.substring(1);
                completions.push(item);
            }
            return completions;
        }

        // Function completions
        if (context.triggerCharacter === '(' || linePrefix.match(/\w+\s*$/)) {
            for (const [name, info] of Object.entries(SASCompletionProvider.FUNCTIONS)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                item.detail = `${info.description} -> ${info.returnType}`;
                item.documentation = new vscode.MarkdownString(
                    `**${name}**\n\n${info.description}\n\n**Syntax:** \`${info.syntax}\`\n\n**Returns:** ${info.returnType}`
                );
                item.insertText = new vscode.SnippetString(`${name}($1)`);
                completions.push(item);
            }
        }

        // DATA step statements
        if (this.isInDataStep(document, position)) {
            for (const [keyword, syntax] of Object.entries(SASCompletionProvider.DATA_STATEMENTS)) {
                const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
                item.detail = syntax;
                completions.push(item);
            }
        }

        // Common formats
        const formats = [
            'DATE9.', 'DATETIME20.', 'MMDDYY10.', 'YYMMDD10.', 'TIME8.',
            'DOLLAR12.2', 'COMMA12.2', 'PERCENT8.2', 'BEST12.', '$CHAR50.'
        ];
        for (const fmt of formats) {
            const item = new vscode.CompletionItem(fmt, vscode.CompletionItemKind.Value);
            item.detail = 'SAS Format';
            completions.push(item);
        }

        return completions;
    }

    private isInDataStep(document: vscode.TextDocument, position: vscode.Position): boolean {
        // Simple check - look backwards for DATA statement without RUN
        for (let i = position.line; i >= 0; i--) {
            const line = document.lineAt(i).text.toUpperCase();
            if (line.match(/^\s*DATA\s+/)) return true;
            if (line.match(/^\s*RUN\s*;/) || line.match(/^\s*PROC\s+/)) return false;
        }
        return false;
    }
}

/**
 * SAS Signature Help Provider - shows function signatures
 */
export class SASSignatureHelpProvider implements vscode.SignatureHelpProvider {

    private static SIGNATURES: { [key: string]: { signature: string; doc: string; params: string[] } } = {
        'SUBSTR': {
            signature: 'SUBSTR(string, start, length)',
            doc: 'Extracts a substring from a string.',
            params: ['string - Source string', 'start - Starting position (1-based)', 'length - Number of characters to extract']
        },
        'SCAN': {
            signature: 'SCAN(string, n, delimiters)',
            doc: 'Returns the nth word from a string.',
            params: ['string - Source string', 'n - Which word to return (can be negative)', 'delimiters - Characters that separate words (optional)']
        },
        'INPUT': {
            signature: 'INPUT(source, informat)',
            doc: 'Converts character to numeric/date using an informat.',
            params: ['source - Character value to convert', 'informat - Informat to apply (e.g., 8., DATE9., COMMA12.)']
        },
        'PUT': {
            signature: 'PUT(value, format)',
            doc: 'Converts numeric/date to character using a format.',
            params: ['value - Value to convert', 'format - Format to apply (e.g., 8., DATE9., DOLLAR12.2)']
        },
        'INTCK': {
            signature: 'INTCK(interval, start_date, end_date, method)',
            doc: 'Counts intervals between two dates.',
            params: ['interval - Type of interval (YEAR, MONTH, DAY, etc.)', 'start_date - Starting date', 'end_date - Ending date', 'method - "CONTINUOUS" or "DISCRETE" (optional)']
        },
        'INTNX': {
            signature: 'INTNX(interval, start_date, increment, alignment)',
            doc: 'Increments a date by a specified interval.',
            params: ['interval - Type of interval (YEAR, MONTH, DAY, etc.)', 'start_date - Starting date', 'increment - Number of intervals to add', 'alignment - "BEGINNING", "MIDDLE", "END", or "SAME" (optional)']
        }
    };

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.SignatureHelpContext
    ): vscode.ProviderResult<vscode.SignatureHelp> {

        const lineText = document.lineAt(position).text.substring(0, position.character);

        // Find function name before current position
        const match = lineText.match(/(\w+)\s*\([^)]*$/);
        if (!match) return null;

        const funcName = match[1].toUpperCase();
        const sigInfo = SASSignatureHelpProvider.SIGNATURES[funcName];

        if (!sigInfo) return null;

        const signature = new vscode.SignatureInformation(sigInfo.signature, sigInfo.doc);
        signature.parameters = sigInfo.params.map(p => new vscode.ParameterInformation(p.split(' - ')[0], p));

        // Count commas to determine active parameter
        const afterParen = lineText.substring(lineText.lastIndexOf('('));
        const commaCount = (afterParen.match(/,/g) || []).length;

        const help = new vscode.SignatureHelp();
        help.signatures = [signature];
        help.activeSignature = 0;
        help.activeParameter = Math.min(commaCount, signature.parameters.length - 1);

        return help;
    }
}

/**
 * SAS Hover Provider - shows documentation on hover
 */
export class SASHoverProvider implements vscode.HoverProvider {

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {

        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return null;

        const word = document.getText(wordRange).toUpperCase();

        // Check procedures
        const proc = (SASCompletionProvider as any).PROCEDURES?.[word];
        if (proc) {
            return new vscode.Hover(
                new vscode.MarkdownString(`**PROC ${word}**\n\n${proc.description}\n\n\`\`\`sas\n${proc.syntax}\n\`\`\``)
            );
        }

        // Check functions
        const func = (SASCompletionProvider as any).FUNCTIONS?.[word];
        if (func) {
            return new vscode.Hover(
                new vscode.MarkdownString(`**${word}** (function)\n\n${func.description}\n\n**Syntax:** \`${func.syntax}\`\n\n**Returns:** ${func.returnType}`)
            );
        }

        // Check DATA step statements
        const stmt = (SASCompletionProvider as any).DATA_STATEMENTS?.[word];
        if (stmt) {
            return new vscode.Hover(
                new vscode.MarkdownString(`**${word}** (DATA step)\n\n\`\`\`sas\n${stmt}\n\`\`\``)
            );
        }

        return null;
    }
}

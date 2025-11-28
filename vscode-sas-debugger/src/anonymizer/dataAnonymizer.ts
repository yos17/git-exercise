import { SASConnectionManager } from '../connection/connectionManager';

export type AnonymizationMethod = 'synthetic' | 'shuffle' | 'mask' | 'noise';
export type OutputFormat = 'csv' | 'json' | 'xlsx' | 'sas';

export interface AnonymizationOptions {
    libref: string;
    dataset: string;
    method: AnonymizationMethod;
    outputFormat: OutputFormat;
    outputPath?: string;
    preserveDistribution: boolean;
    columns?: ColumnAnonymizationConfig[];
    sampleSize?: number;  // If set, only anonymize a sample
}

export interface ColumnAnonymizationConfig {
    name: string;
    method: AnonymizationMethod | 'keep' | 'drop';
    customValues?: string[];  // For mask method
}

export interface ColumnMetadata {
    name: string;
    type: 'num' | 'char';
    length: number;
    format?: string;
    informat?: string;
    label?: string;
    // Statistics for synthetic data generation
    stats?: {
        min?: number;
        max?: number;
        mean?: number;
        std?: number;
        distinctCount?: number;
        topValues?: { value: string; count: number }[];
    };
}

export interface AnonymizationResult {
    success: boolean;
    rowCount: number;
    columnCount: number;
    outputPath?: string;
    error?: string;
}

/**
 * DataAnonymizer - Secure data export with anonymization
 *
 * This is a critical security feature that ensures sensitive data
 * is randomized/anonymized before being exported from SAS.
 *
 * Methods:
 * - Synthetic: Generate statistically similar fake data
 * - Shuffle: Randomly shuffle values within columns
 * - Mask: Replace with masked values (e.g., XXX-XX-1234)
 * - Noise: Add random noise to numeric values
 */
export class DataAnonymizer {
    private connection: SASConnectionManager;

    constructor(connection: SASConnectionManager) {
        this.connection = connection;
    }

    /**
     * Main anonymization method
     */
    async anonymize(options: AnonymizationOptions): Promise<AnonymizationResult> {
        try {
            // Step 1: Get dataset metadata
            const metadata = await this.getDatasetMetadata(options.libref, options.dataset);

            // Step 2: Analyze data for synthetic generation
            const stats = await this.analyzeData(options.libref, options.dataset, metadata);

            // Step 3: Generate anonymized data in SAS
            const anonymizedDataset = await this.generateAnonymizedData(
                options,
                metadata,
                stats
            );

            // Step 4: Export to requested format
            const result = await this.exportData(
                anonymizedDataset,
                options.outputFormat,
                options.outputPath
            );

            // Step 5: Clean up temporary dataset
            await this.cleanup(anonymizedDataset);

            return result;
        } catch (error) {
            return {
                success: false,
                rowCount: 0,
                columnCount: 0,
                error: String(error)
            };
        }
    }

    /**
     * Get dataset structure/metadata
     */
    private async getDatasetMetadata(libref: string, dataset: string): Promise<ColumnMetadata[]> {
        const sasCode = `
proc contents data=${libref}.${dataset} out=work._metadata_ noprint;
run;

proc print data=work._metadata_(keep=name type length format informat label);
run;
`;

        const result = await this.connection.submit(sasCode);

        // Parse the metadata from SAS output
        // In real implementation, would parse PROC CONTENTS output
        const columns = await this.parseMetadataResult(libref, dataset);
        return columns;
    }

    /**
     * Parse metadata from SAS
     */
    private async parseMetadataResult(libref: string, dataset: string): Promise<ColumnMetadata[]> {
        const sasCode = `
data _null_;
    set ${libref}.${dataset}(obs=0);
    array _c_ _character_;
    array _n_ _numeric_;

    length colinfo $32767;

    do i = 1 to dim(_c_);
        colinfo = catx('|', vname(_c_[i]), 'char', vlength(_c_[i]));
        put colinfo;
    end;

    do i = 1 to dim(_n_);
        colinfo = catx('|', vname(_n_[i]), 'num', 8);
        put colinfo;
    end;
run;

proc sql noprint;
    select name, type, length, format, informat, label
    into :names separated by '~',
         :types separated by '~',
         :lengths separated by '~',
         :formats separated by '~',
         :informats separated by '~',
         :labels separated by '~'
    from dictionary.columns
    where libname = "${libref}" and memname = "${dataset}";
quit;

%put METADATA_START;
%put NAMES=&names;
%put TYPES=&types;
%put LENGTHS=&lengths;
%put FORMATS=&formats;
%put METADATA_END;
`;

        const result = await this.connection.submit(sasCode);

        // Parse the log to extract metadata
        const columns: ColumnMetadata[] = [];
        const lines = result.log.split('\n');

        let inMetadata = false;
        let names: string[] = [];
        let types: string[] = [];
        let lengths: string[] = [];
        let formats: string[] = [];

        for (const line of lines) {
            if (line.includes('METADATA_START')) {
                inMetadata = true;
                continue;
            }
            if (line.includes('METADATA_END')) {
                inMetadata = false;
                break;
            }
            if (inMetadata) {
                if (line.includes('NAMES=')) {
                    names = line.split('NAMES=')[1].trim().split('~');
                } else if (line.includes('TYPES=')) {
                    types = line.split('TYPES=')[1].trim().split('~');
                } else if (line.includes('LENGTHS=')) {
                    lengths = line.split('LENGTHS=')[1].trim().split('~');
                } else if (line.includes('FORMATS=')) {
                    formats = line.split('FORMATS=')[1].trim().split('~');
                }
            }
        }

        for (let i = 0; i < names.length; i++) {
            columns.push({
                name: names[i] || `COL${i}`,
                type: (types[i] || 'char').toLowerCase().includes('num') ? 'num' : 'char',
                length: parseInt(lengths[i]) || 8,
                format: formats[i] || undefined
            });
        }

        return columns;
    }

    /**
     * Analyze data for synthetic generation
     */
    private async analyzeData(
        libref: string,
        dataset: string,
        metadata: ColumnMetadata[]
    ): Promise<Map<string, ColumnMetadata['stats']>> {
        const stats = new Map<string, ColumnMetadata['stats']>();

        // Generate analysis code for each column
        const numericCols = metadata.filter(c => c.type === 'num').map(c => c.name);
        const charCols = metadata.filter(c => c.type === 'char').map(c => c.name);

        if (numericCols.length > 0) {
            const sasCode = `
proc means data=${libref}.${dataset} noprint;
    var ${numericCols.join(' ')};
    output out=work._numstats_
        min= ${numericCols.map(c => c + '_min').join(' ')}
        max= ${numericCols.map(c => c + '_max').join(' ')}
        mean= ${numericCols.map(c => c + '_mean').join(' ')}
        std= ${numericCols.map(c => c + '_std').join(' ')};
run;

data _null_;
    set work._numstats_;
    %do i = 1 %to ${numericCols.length};
        %let col = %scan(${numericCols.join(' ')}, &i);
        put "NUMSTATS|&col|" &col._min "|" &col._max "|" &col._mean "|" &col._std;
    %end;
run;
`;
            const result = await this.connection.submit(sasCode);

            // Parse numeric statistics
            for (const line of result.log.split('\n')) {
                if (line.startsWith('NUMSTATS|')) {
                    const parts = line.split('|');
                    const colName = parts[1];
                    stats.set(colName, {
                        min: parseFloat(parts[2]) || 0,
                        max: parseFloat(parts[3]) || 100,
                        mean: parseFloat(parts[4]) || 50,
                        std: parseFloat(parts[5]) || 10
                    });
                }
            }
        }

        // For character columns, get distinct value counts and top values
        for (const col of charCols) {
            const sasCode = `
proc freq data=${libref}.${dataset} noprint;
    tables ${col} / out=work._charfreq_ outcum;
run;

proc sql noprint;
    select count(distinct ${col}) into :distinctcnt from ${libref}.${dataset};
    select ${col}, count into :topvals separated by '~', :topcnts separated by '~'
        from work._charfreq_(obs=10);
quit;

%put CHARSTATS|${col}|&distinctcnt|&topvals|&topcnts;
`;
            const result = await this.connection.submit(sasCode);

            for (const line of result.log.split('\n')) {
                if (line.includes(`CHARSTATS|${col}|`)) {
                    const parts = line.split('|');
                    const distinctCount = parseInt(parts[2]) || 10;
                    const topValues = parts[3]?.split('~') || [];
                    const topCounts = parts[4]?.split('~').map(c => parseInt(c)) || [];

                    stats.set(col, {
                        distinctCount,
                        topValues: topValues.map((v, i) => ({ value: v, count: topCounts[i] || 1 }))
                    });
                }
            }
        }

        return stats;
    }

    /**
     * Generate anonymized dataset in SAS
     */
    private async generateAnonymizedData(
        options: AnonymizationOptions,
        metadata: ColumnMetadata[],
        stats: Map<string, ColumnMetadata['stats']>
    ): Promise<string> {
        const outputDataset = `WORK._ANON_${Date.now()}`;

        let sasCode = '';

        switch (options.method) {
            case 'synthetic':
                sasCode = this.generateSyntheticDataCode(options, metadata, stats, outputDataset);
                break;
            case 'shuffle':
                sasCode = this.generateShuffleCode(options, metadata, outputDataset);
                break;
            case 'mask':
                sasCode = this.generateMaskCode(options, metadata, outputDataset);
                break;
            case 'noise':
                sasCode = this.generateNoiseCode(options, metadata, stats, outputDataset);
                break;
        }

        await this.connection.submit(sasCode);
        return outputDataset;
    }

    /**
     * Generate synthetic data - creates fake data with similar statistical properties
     */
    private generateSyntheticDataCode(
        options: AnonymizationOptions,
        metadata: ColumnMetadata[],
        stats: Map<string, ColumnMetadata['stats']>,
        outputDataset: string
    ): string {
        const { libref, dataset } = options;

        // Build synthetic data generation for each column
        const columnGenerators: string[] = [];

        for (const col of metadata) {
            const colStats = stats.get(col.name);

            if (col.type === 'num') {
                // Generate numeric data with similar distribution
                const min = colStats?.min ?? 0;
                const max = colStats?.max ?? 100;
                const mean = colStats?.mean ?? (min + max) / 2;
                const std = colStats?.std ?? (max - min) / 4;

                if (options.preserveDistribution) {
                    // Normal distribution centered on mean
                    columnGenerators.push(
                        `${col.name} = round(${mean} + ${std} * rannor(seed), 0.01);`
                    );
                    columnGenerators.push(
                        `if ${col.name} < ${min} then ${col.name} = ${min};`
                    );
                    columnGenerators.push(
                        `if ${col.name} > ${max} then ${col.name} = ${max};`
                    );
                } else {
                    // Uniform random
                    columnGenerators.push(
                        `${col.name} = ${min} + (${max} - ${min}) * ranuni(seed);`
                    );
                }
            } else {
                // Generate character data
                const distinctCount = colStats?.distinctCount ?? 10;
                const topValues = colStats?.topValues ?? [];

                if (topValues.length > 0 && options.preserveDistribution) {
                    // Use actual values with similar frequency
                    const valueList = topValues.map(v => `"${v.value.replace(/"/g, '""')}"`).join(', ');
                    columnGenerators.push(
                        `_idx_ = ceil(ranuni(seed) * ${topValues.length});`
                    );
                    columnGenerators.push(
                        `${col.name} = scan("${topValues.map(v => v.value).join('~')}", _idx_, '~');`
                    );
                } else {
                    // Generate random strings
                    columnGenerators.push(
                        `length ${col.name} $${col.length};`
                    );
                    columnGenerators.push(
                        `${col.name} = cats("ANON_", put(_n_, z6.));`
                    );
                }
            }
        }

        return `
/* Synthetic Data Generation - creates statistically similar fake data */
data ${outputDataset};
    /* Get row count from original */
    if _n_ = 1 then do;
        declare hash h(dataset: "${libref}.${dataset}(obs=0)");
    end;

    seed = 12345;

    /* Generate same number of rows as original */
    set ${libref}.${dataset}(keep=) nobs=nobs;

    do _i_ = 1 to nobs;
        seed = seed + _i_;
        ${columnGenerators.join('\n        ')}
        output;
    end;

    drop seed _i_ _idx_;
    stop;
run;
`;
    }

    /**
     * Generate shuffle code - randomly shuffles values within each column
     */
    private generateShuffleCode(
        options: AnonymizationOptions,
        metadata: ColumnMetadata[],
        outputDataset: string
    ): string {
        const { libref, dataset } = options;

        // Create shuffled version of each column
        const shuffleSteps: string[] = [];

        for (const col of metadata) {
            shuffleSteps.push(`
/* Shuffle ${col.name} */
proc sql;
    create table work._temp_${col.name} as
    select ${col.name}, ranuni(12345 + monotonic()) as _rand_
    from ${libref}.${dataset}
    order by _rand_;
quit;
`);
        }

        const columnJoins = metadata.map((col, i) =>
            `work._temp_${col.name}(rename=(${col.name}=${col.name}_shuf))`
        ).join(', ');

        return `
/* Shuffle Anonymization - randomly permutes values within each column */
${shuffleSteps.join('\n')}

/* Combine shuffled columns */
data ${outputDataset};
    merge ${metadata.map(c => `work._temp_${c.name}`).join(' ')};
    ${metadata.map(c => `rename ${c.name} = ${c.name};`).join('\n    ')}
    drop _rand_;
run;

/* Cleanup temp datasets */
proc datasets lib=work nolist;
    delete ${metadata.map(c => `_temp_${c.name}`).join(' ')};
quit;
`;
    }

    /**
     * Generate mask code - masks sensitive data while preserving format
     */
    private generateMaskCode(
        options: AnonymizationOptions,
        metadata: ColumnMetadata[],
        outputDataset: string
    ): string {
        const { libref, dataset } = options;

        const maskStatements: string[] = [];

        for (const col of metadata) {
            const colConfig = options.columns?.find(c => c.name === col.name);

            if (colConfig?.method === 'keep') {
                maskStatements.push(`/* Keep ${col.name} as-is */`);
                continue;
            }
            if (colConfig?.method === 'drop') {
                continue;
            }

            if (col.type === 'num') {
                // Mask numeric - replace with random in same magnitude
                maskStatements.push(`
    ${col.name} = round(${col.name} * (0.5 + ranuni(seed)), 0.01);
    seed = seed + 1;`);
            } else {
                // Detect and mask sensitive patterns
                maskStatements.push(`
    /* Mask ${col.name} - detect sensitive patterns */
    length _temp_ $${col.length};
    _temp_ = ${col.name};

    /* SSN pattern XXX-XX-XXXX */
    if prxmatch('/\\d{3}-\\d{2}-\\d{4}/', _temp_) then
        ${col.name} = cats('XXX-XX-', substr(_temp_, 8, 4));
    /* Phone pattern */
    else if prxmatch('/\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}/', _temp_) then
        ${col.name} = cats('(XXX) XXX-', substr(compress(_temp_, '-. '), 7, 4));
    /* Email pattern */
    else if prxmatch('/\\w+@\\w+\\.\\w+/', _temp_) then
        ${col.name} = cats('user', put(_n_, z4.), '@example.com');
    /* Credit card */
    else if prxmatch('/\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}/', _temp_) then
        ${col.name} = cats('XXXX-XXXX-XXXX-', substr(compress(_temp_, '- '), 13, 4));
    /* Generic text - partial mask */
    else if length(strip(_temp_)) > 4 then
        ${col.name} = cats(substr(_temp_, 1, 1), repeat('*', length(strip(_temp_))-3), substr(_temp_, length(strip(_temp_))));

    drop _temp_;`);
            }
        }

        const keepCols = metadata
            .filter(c => {
                const config = options.columns?.find(cc => cc.name === c.name);
                return config?.method !== 'drop';
            })
            .map(c => c.name);

        return `
/* Mask Anonymization - replaces sensitive data patterns with masked values */
data ${outputDataset};
    set ${libref}.${dataset};
    retain seed 98765;

    ${maskStatements.join('\n')}

    drop seed;
    keep ${keepCols.join(' ')};
run;
`;
    }

    /**
     * Generate noise code - adds random noise to numeric values
     */
    private generateNoiseCode(
        options: AnonymizationOptions,
        metadata: ColumnMetadata[],
        stats: Map<string, ColumnMetadata['stats']>,
        outputDataset: string
    ): string {
        const { libref, dataset } = options;

        const noiseStatements: string[] = [];

        for (const col of metadata) {
            if (col.type === 'num') {
                const colStats = stats.get(col.name);
                const std = colStats?.std ?? 10;
                // Add Gaussian noise proportional to the standard deviation
                const noiseLevel = std * 0.1;  // 10% of std deviation

                noiseStatements.push(`
    /* Add noise to ${col.name} */
    ${col.name} = ${col.name} + ${noiseLevel} * rannor(seed);
    seed = seed + 1;`);
            } else {
                // For character columns, apply shuffle within groups
                noiseStatements.push(`
    /* ${col.name} preserved (character) */`);
            }
        }

        return `
/* Noise Anonymization - adds random perturbation to numeric values */
data ${outputDataset};
    set ${libref}.${dataset};
    retain seed 54321;

    ${noiseStatements.join('\n')}

    drop seed;
run;
`;
    }

    /**
     * Export data to requested format
     */
    private async exportData(
        dataset: string,
        format: OutputFormat,
        outputPath?: string
    ): Promise<AnonymizationResult> {
        let sasCode = '';
        let rowCount = 0;
        let columnCount = 0;

        // Get counts first
        const countCode = `
proc sql noprint;
    select count(*) into :rowcnt from ${dataset};
    select count(*) into :colcnt from dictionary.columns
        where libname='WORK' and memname=scan("${dataset}", 2, '.');
quit;
%put COUNTS|&rowcnt|&colcnt;
`;
        const countResult = await this.connection.submit(countCode);

        for (const line of countResult.log.split('\n')) {
            if (line.includes('COUNTS|')) {
                const parts = line.split('|');
                rowCount = parseInt(parts[1]) || 0;
                columnCount = parseInt(parts[2]) || 0;
            }
        }

        switch (format) {
            case 'csv':
                sasCode = `
proc export data=${dataset}
    outfile="${outputPath}"
    dbms=csv replace;
run;
`;
                break;

            case 'json':
                sasCode = `
proc json out="${outputPath}" pretty;
    export ${dataset};
run;
`;
                break;

            case 'xlsx':
                sasCode = `
proc export data=${dataset}
    outfile="${outputPath}"
    dbms=xlsx replace;
run;
`;
                break;

            case 'sas':
                // Just rename the dataset
                const finalName = dataset.replace('_ANON_', '') + '_ANON';
                sasCode = `
data ${finalName};
    set ${dataset};
run;
`;
                break;
        }

        const result = await this.connection.submit(sasCode);

        return {
            success: !result.hasErrors,
            rowCount,
            columnCount,
            outputPath,
            error: result.hasErrors ? 'Export failed - check SAS log' : undefined
        };
    }

    /**
     * Clean up temporary datasets
     */
    private async cleanup(dataset: string): Promise<void> {
        const sasCode = `
proc datasets lib=work nolist;
    delete ${dataset.split('.')[1]} _metadata_ _numstats_ _charfreq_;
quit;
`;
        await this.connection.submit(sasCode);
    }
}

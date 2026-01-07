const awsConfig = require('../config/aws');
const moment = require('moment');

class AthenaService {
  constructor() {
    this.athena = awsConfig.getAthena();
    this.s3 = awsConfig.getS3(); // For immediate result cleanup
    this.s3OutputBucket = process.env.ATHENA_OUTPUT_BUCKET || awsConfig.getBucketName();
    this.s3OutputPrefix = process.env.ATHENA_OUTPUT_PREFIX || 'temp-results/';
    this.databaseName = process.env.ATHENA_DATABASE || 'weather_archive';
    this.defaultTimeout = 300000; // 5 minutes
    this.immediateCleanup = process.env.ATHENA_IMMEDIATE_CLEANUP !== 'false'; // Default: true
  }

  /**
   * Pre-validate date input to avoid moment.js errors entirely
   */
  isValidDateInput(dateInput) {
    if (!dateInput || dateInput === 'undefined' || dateInput === 'null') {
      return false;
    }

    if (typeof dateInput === 'string') {
      const trimmed = dateInput.trim();
      if (trimmed === '' || trimmed === 'Invalid date' || trimmed === 'NaN' ||
        trimmed.includes('invalid') || trimmed.includes('Invalid')) {
        return false;
      }

      const basicDatePattern = /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/;
      const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

      if (!basicDatePattern.test(trimmed) && !isoPattern.test(trimmed)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Safely create moment object without throwing errors
   */
  safeMoment(dateInput) {
    if (!this.isValidDateInput(dateInput)) {
      return null;
    }

    try {
      const momentObj = moment(dateInput);
      return momentObj.isValid() ? momentObj : null;
    } catch (error) {
      console.warn(`Moment parsing error in Athena for "${dateInput}":`, error.message);
      return null;
    }
  }

  /**
   * Safely parse date and extract year with validation
   */
  getYearFromDate(dateString, defaultYear = null) {
    const dateMoment = this.safeMoment(dateString);
    if (!dateMoment) {
      console.warn(`Invalid date in Athena query: ${dateString}, using default year: ${defaultYear}`);
      return defaultYear;
    }

    return dateMoment.year();
  }

  /**
   * Execute SQL query on archived Parquet data using Athena
   * Much more efficient than downloading and processing files locally
   */
  async executeQuery(sql, options = {}) {
    let queryExecutionId = null;

    try {
      console.log('Executing Athena query on Parquet data...');

      const params = {
        QueryString: sql,
        ResultConfiguration: {
          OutputLocation: `s3://${this.s3OutputBucket}/${this.s3OutputPrefix}`,
          EncryptionConfiguration: {
            EncryptionOption: 'SSE_S3'
          }
        },
        WorkGroup: options.workGroup || 'primary'
      };

      // Start query execution
      const startResult = await this.athena.startQueryExecution(params).promise();
      queryExecutionId = startResult.QueryExecutionId;

      console.log(`Query started with ID: ${queryExecutionId}`);

      // Wait for query completion
      const queryResult = await this.waitForQueryCompletion(queryExecutionId, options.timeout);

      if (queryResult.status === 'SUCCEEDED') {
        // Get query results directly from Athena API
        const results = await this.getQueryResults(queryExecutionId);

        console.log(`Athena query completed: ${results.length} rows returned`);

        // IMMEDIATE CLEANUP: Delete S3 result files right after getting data
        if (this.immediateCleanup) {
          await this.cleanupQueryResults(queryExecutionId);
        }

        return {
          success: true,
          data: results,
          queryExecutionId,
          statistics: queryResult.statistics,
          source: 'athena-direct', // Updated to reflect direct results
          resultsCleaned: this.immediateCleanup
        };
      } else {
        throw new Error(`Query failed with status: ${queryResult.status}. Reason: ${queryResult.reason}`);
      }
    } catch (error) {
      console.error('Athena query error:', error);

      // Cleanup on error too (if query was started)
      if (queryExecutionId && this.immediateCleanup) {
        try {
          await this.cleanupQueryResults(queryExecutionId);
        } catch (cleanupError) {
          console.warn('Cleanup warning:', cleanupError.message);
        }
      }

      throw new Error(`Athena query failed: ${error.message}`);
    }
  }

  /**
   * Wait for query completion with timeout
   */
  async waitForQueryCompletion(queryExecutionId, timeout = this.defaultTimeout) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const result = await this.athena.getQueryExecution({
          QueryExecutionId: queryExecutionId
        }).promise();

        const status = result.QueryExecution.Status.State;

        if (status === 'SUCCEEDED') {
          return {
            status: 'SUCCEEDED',
            statistics: result.QueryExecution.Statistics
          };
        } else if (status === 'FAILED' || status === 'CANCELLED') {
          return {
            status,
            reason: result.QueryExecution.Status.StateChangeReason
          };
        }

        // Query still running, wait before checking again
        await this.sleep(2000); // 2 seconds
      } catch (error) {
        console.error('Error checking query status:', error);
        throw error;
      }
    }

    throw new Error(`Query timeout after ${timeout}ms`);
  }

  /**
   * Get query results from Athena
   */
  async getQueryResults(queryExecutionId) {
    try {
      const results = [];
      let nextToken = null;

      do {
        const params = {
          QueryExecutionId: queryExecutionId,
          MaxResults: 1000
        };

        if (nextToken) {
          params.NextToken = nextToken;
        }

        const response = await this.athena.getQueryResults(params).promise();

        // Skip header row for first batch
        const rows = nextToken ? response.ResultSet.Rows : response.ResultSet.Rows.slice(1);

        // Convert rows to objects
        const columnNames = response.ResultSet.ResultSetMetadata.ColumnInfo.map(col => col.Name);

        rows.forEach(row => {
          const record = {};
          row.Data.forEach((field, index) => {
            record[columnNames[index]] = field.VarCharValue || null;
          });
          results.push(record);
        });

        nextToken = response.NextToken;
      } while (nextToken);

      return results;
    } catch (error) {
      console.error('Error getting query results:', error);
      throw error;
    }
  }

  /**
   * Immediate cleanup of Athena query result files from S3
   * Deletes both CSV result and metadata files right after getting data
   */
  async cleanupQueryResults(queryExecutionId) {
    if (!this.immediateCleanup) {
      return; // Cleanup disabled
    }

    try {
      // Athena creates files with this naming pattern
      const csvKey = `${this.s3OutputPrefix}${queryExecutionId}.csv`;
      const metadataKey = `${this.s3OutputPrefix}${queryExecutionId}.csv.metadata`;

      console.log(`Cleaning up query results for ${queryExecutionId}...`);

      // Delete both result and metadata files in parallel
      const deletePromises = [
        this.s3.deleteObject({
          Bucket: this.s3OutputBucket,
          Key: csvKey
        }).promise(),
        this.s3.deleteObject({
          Bucket: this.s3OutputBucket,
          Key: metadataKey
        }).promise()
      ];

      await Promise.all(deletePromises);

      console.log(`Query result files cleaned up successfully`);

    } catch (error) {
      console.warn(`Cleanup warning for ${queryExecutionId}:`, error.message);
      // Don't fail the query if cleanup fails - just warn
    }
  }

  /**
   * Query archived data with Athena (optimized for year-partitioned Parquet)
   * Supports both weather_reports and project_hours tables
   */
  async queryArchivedData(tableName, filters = {}, options = {}) {
    try {
      let sql = `SELECT * FROM ${this.databaseName}.${tableName}_archive`;
      const conditions = [];

      // Add year-based partition pruning (more efficient)
      if (filters.startDate) {
        const startYear = this.getYearFromDate(filters.startDate);
        if (startYear) {
          conditions.push(`archive_year >= ${startYear}`);
        }
      }

      if (filters.endDate) {
        const endYear = this.getYearFromDate(filters.endDate);
        if (endYear) {
          conditions.push(`archive_year <= ${endYear}`);
        }
      }

      // Add project filter (common to both tables)
      if (filters.projectId) {
        conditions.push(`project_id = ${filters.projectId}`);
      }

      // Add table-specific filters
      if (tableName === 'weather_reports' && filters.quarters && Array.isArray(filters.quarters)) {
        const quarterList = filters.quarters.map(q => `'${q}'`).join(',');
        conditions.push(`quarter IN (${quarterList})`);
      }

      // Add precise date range filter
      if (filters.startDate) {
        conditions.push(`created_at >= TIMESTAMP '${filters.startDate}'`);
      }

      if (filters.endDate) {
        conditions.push(`created_at <= TIMESTAMP '${filters.endDate}'`);
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      // Add ordering
      if (options.orderBy) {
        sql += ` ORDER BY ${options.orderBy}`;
        if (options.orderDirection) {
          sql += ` ${options.orderDirection}`;
        }
      }

      // Add limit
      if (options.limit) {
        sql += ` LIMIT ${options.limit}`;
      }

      console.log(`Athena SQL (${tableName}): ${sql}`);

      return await this.executeQuery(sql, options);
    } catch (error) {
      console.error(`${tableName} Athena query error:`, error);
      throw error;
    }
  }

  /**
   * Get archived data count with Athena (year-partitioned)
   * Supports both weather_reports and project_hours tables
   */
  async getArchivedCount(tableName, filters = {}) {
    try {
      let sql = `SELECT COUNT(*) as total_count FROM ${this.databaseName}.${tableName}_archive`;
      const conditions = [];

      // Add year-based partition filters
      if (filters.startDate) {
        const startYear = this.getYearFromDate(filters.startDate);
        if (startYear) {
          conditions.push(`archive_year >= ${startYear}`);
        }
        conditions.push(`created_at >= TIMESTAMP '${filters.startDate}'`);
      }

      if (filters.endDate) {
        const endYear = this.getYearFromDate(filters.endDate);
        if (endYear) {
          conditions.push(`archive_year <= ${endYear}`);
        }
        conditions.push(`created_at <= TIMESTAMP '${filters.endDate}'`);
      }

      if (filters.projectId) {
        conditions.push(`project_id = ${filters.projectId}`);
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      const result = await this.executeQuery(sql);
      return parseInt(result.data[0]?.total_count || '0', 10);
    } catch (error) {
      console.error(`${tableName} count Athena query error:`, error);
      throw error;
    }
  }

  /**
   * Create or update Athena table for archived data
   * Supports both weather_reports and project_hours tables
   */
  async createArchivedTable(tableName, s3ArchiveService) {
    try {
      const ddl = s3ArchiveService.generateAthenaTableDDL(tableName, this.databaseName);

      console.log(`Creating Athena table for ${tableName}...`);
      console.log(ddl);

      // Execute the CREATE TABLE statement
      const result = await this.executeQuery(ddl);

      console.log(`Athena table ${tableName} created successfully`);
      return result;
    } catch (error) {
      console.error(`Error creating Athena table ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Check if Athena table exists
   */
  async tableExists(tableName) {
    try {
      const sql = `SHOW TABLES IN ${this.databaseName} LIKE '${tableName}'`;
      const result = await this.executeQuery(sql);
      return result.data.length > 0;
    } catch (error) {
      console.error('Error checking table existence:', error);
      return false;
    }
  }

  /**
   * Get Athena query history for debugging
   */
  async getQueryHistory(limit = 10) {
    try {
      const params = {
        MaxResults: limit
      };

      const response = await this.athena.listQueryExecutions(params).promise();
      const queryIds = response.QueryExecutionIds;

      const queries = [];
      for (const queryId of queryIds) {
        const execution = await this.athena.getQueryExecution({
          QueryExecutionId: queryId
        }).promise();

        queries.push({
          queryId,
          query: execution.QueryExecution.Query,
          status: execution.QueryExecution.Status.State,
          startTime: execution.QueryExecution.Status.SubmissionDateTime,
          endTime: execution.QueryExecution.Status.CompletionDateTime,
          dataScanned: execution.QueryExecution.Statistics?.DataScannedInBytes,
          executionTime: execution.QueryExecution.Statistics?.EngineExecutionTimeInMillis
        });
      }

      return queries;
    } catch (error) {
      console.error('Error getting query history:', error);
      throw error;
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AthenaService;

const awsConfig = require('../config/aws');
const moment = require('moment');
require('moment-timezone');
const parquet = require('parquetjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

class S3ArchiveService {
  constructor() {
    this.s3 = awsConfig.getS3();
    this.bucket = awsConfig.getBucketName();
    this.prefix = awsConfig.getArchivePrefix();
    this.tempDir = path.join(os.tmpdir(), 'parquet-archive');
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    // Clean up any existing temp files on startup
    this.cleanupTempDirectory();
  }

  /**
   * Get archive prefix for a specific table
   */
  getTablePrefix(tableName) {
    const lower = String(tableName || '').toLowerCase();
    if (lower === 'project_hours') {
      return 'project-hours/';
    }
    return this.prefix;
  }

  /**
   * Clean up temporary directory and old files
   */
  cleanupTempDirectory() {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        const now = Date.now();
        
        for (const file of files) {
          const filePath = path.join(this.tempDir, file);
          try {
            const stats = fs.statSync(filePath);
            // Delete files older than 1 hour
            if (now - stats.mtime.getTime() > 3600000) {
              fs.unlinkSync(filePath);
            }
          } catch (error) {
            // File might have been deleted already, ignore
          }
        }
      }
    } catch (error) {
      console.warn('Could not clean temp directory:', error.message);
    }
  }

  /**
   * Safe cleanup of temporary file with better error handling
   */
  cleanupTempFile(tempFilePath, suppressLogs = false) {
    if (!tempFilePath) return;
    
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        // intentionally silent
      }
    } catch (cleanupError) {
      console.error(`Error cleaning up temp file ${path.basename(tempFilePath)}:`, cleanupError.message);
    }
  }

  /**
   * Get Parquet schema for weather_reports table
   * Optimized for Athena performance with proper data types
   * Uses year-based partitioning for optimal performance
   */
  getWeatherReportsSchema() {
    return new parquet.ParquetSchema({
      id: { type: 'INT64', optional: false },
      project_id: { type: 'INT32', optional: false },
      quarter: { type: 'UTF8', optional: false }, // enum as string
      created_at: { type: 'TIMESTAMP_MILLIS', optional: false },
      updated_at: { type: 'TIMESTAMP_MILLIS', optional: false },
      day_forecast: { type: 'UTF8', optional: false },
      timezone: { type: 'UTF8', optional: true },
      
      // Archive metadata fields (year-based partitioning)
      archive_year: { type: 'INT32', optional: false },
      archive_date: { type: 'TIMESTAMP_MILLIS', optional: false }
    });
  }

  /**
   * Get Parquet schema for project_hours table
   */
  getProjectHoursSchema() {
    return new parquet.ParquetSchema({
      id: { type: 'INT64', optional: false },
      project_id: { type: 'INT64', optional: false },
      user_id: { type: 'INT64', optional: false },
      name: { type: 'UTF8', optional: true },
      quantity: { type: 'INT64', optional: true },
      hours: { type: 'DOUBLE', optional: true },
      total_hours: { type: 'DOUBLE', optional: true },
      description: { type: 'UTF8', optional: true },
      submission_date: { type: 'INT32', originalType: 'DATE', optional: false },
      to_delete: { type: 'INT32', optional: true },
      has_no_work: { type: 'INT32', optional: true },
      created_at: { type: 'TIMESTAMP_MILLIS', optional: false },
      updated_at: { type: 'TIMESTAMP_MILLIS', optional: true },

      // Archive metadata fields (year-based partitioning)
      archive_year: { type: 'INT32', optional: false },
      archive_date: { type: 'TIMESTAMP_MILLIS', optional: false }
    });
  }

  /**
   * Get dynamic Parquet schema for any table
   * Infers types from the data structure with year-based partitioning
   */
  getDynamicParquetSchema(tableName, sampleRecord) {
    const schemaFields = {};
    
    // Add archive metadata (year-based partitioning only)
    schemaFields.archive_year = { type: 'INT32', optional: false };
    schemaFields.archive_date = { type: 'TIMESTAMP_MILLIS', optional: false };
    
    // Infer field types from sample record
    Object.keys(sampleRecord).forEach(field => {
      const value = sampleRecord[field];
      const lowerField = String(field).toLowerCase();
      
      if (field === 'id' || field.endsWith('_id')) {
        schemaFields[field] = { type: 'INT64', optional: false };
      } else if (lowerField === 'timezone') {
        // Ensure timezone is stored as string, not a timestamp
        schemaFields[field] = { type: 'UTF8', optional: true };
      } else if (typeof value === 'number') {
        // Check if it's an integer or float
        schemaFields[field] = { 
          type: Number.isInteger(value) ? 'INT32' : 'DOUBLE', 
          optional: true 
        };
      } else if (value instanceof Date || moment.isDate(value) || moment.isMoment(value)) {
        schemaFields[field] = { type: 'TIMESTAMP_MILLIS', optional: true };
      } else if ((lowerField.includes('date') || lowerField.includes('time')) && lowerField !== 'timezone') {
        // Date/time fields as timestamps
        schemaFields[field] = { type: 'TIMESTAMP_MILLIS', optional: true };
      } else {
        // Default to UTF8 (string)
        schemaFields[field] = { type: 'UTF8', optional: true };
      }
    });

    return new parquet.ParquetSchema(schemaFields);
  }

  /**
   * Archive data to S3 Glacier Instant Retrieval in Parquet format
   * Automatically partitions by year for optimal Athena performance
   */
  async archiveData(tableName, data, providedYear = null) {
    let tempFilePath = null;
    
    try {
      if (!Array.isArray(data) || data.length === 0) {
        return { success: true, archivedCount: 0 };
      }

      // Auto-detect year from data if not provided
      const year = providedYear || this.detectYearFromData(data);
      
      console.log(`Creating Parquet file for ${data.length} records (Year ${year})...`);

      // Create year-based partition path with smart redundancy detection
      const partitionPath = this.buildPartitionPath(tableName, year);
      const fileName = `data_${Date.now()}.parquet`;
      const key = `${partitionPath}${fileName}`;

      // Create temporary file path
      tempFilePath = path.join(this.tempDir, `${tableName}_${year}_${Date.now()}.parquet`);

      // Get appropriate schema
      const lowerTable = String(tableName).toLowerCase();
      const schema = lowerTable === 'weather_reports'
        ? this.getWeatherReportsSchema()
        : lowerTable === 'project_hours'
          ? this.getProjectHoursSchema()
          : this.getDynamicParquetSchema(tableName, data[0]);

      // Create Parquet writer with optimized settings
      const writer = await parquet.ParquetWriter.openFile(schema, tempFilePath, {
        compression: 'SNAPPY', // Great balance of compression and speed
        rowGroupSize: 8192,    // Optimal for Athena
        bitWidth: 64           // Better for large datasets
      });

      // Prepare and write data
      const archiveTimestamp = new Date();
      
      for (const record of data) {
        // Transform the record for Parquet (year-based partitioning)
        const parquetRecord = this.transformRecordForParquet(record, year, archiveTimestamp);
        await writer.appendRow(parquetRecord);
      }

      // Close the writer
      await writer.close();

      // Get file stats for upload
      const stats = fs.statSync(tempFilePath);
      const tempFileName = path.basename(tempFilePath);
      console.log(`Parquet file ready: ${tempFileName} (${(stats.size / 1024).toFixed(1)} KB)`);

      // Read the Parquet file and upload to S3
      const fileStream = fs.createReadStream(tempFilePath);

      const params = {
        Bucket: this.bucket,
        Key: key,
        Body: fileStream,
        ContentType: 'application/octet-stream',
        ContentLength: stats.size,
        StorageClass: 'GLACIER_IR', // Glacier Instant Retrieval
        Metadata: {
          'table-name': tableName,
          'record-count': data.length.toString(),
          'archive-year': year.toString(),
          'file-format': 'parquet',
          'compression': 'snappy',
          'schema-version': '2.0', // Updated for year-only partitioning
          'partition-strategy': 'year-based'
        },
        // Add tags for better organization (year-based)
        Tagging: `table=${tableName}&year=${year}&format=parquet&partition=year`
      };

      const uploadResult = await this.s3.upload(params).promise();

      console.log(`Uploaded to S3: ${key} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

      return {
        success: true,
        archivedCount: data.length,
        s3Key: key,
        partitionPath,
        partitionYear: year,
        fileSize: stats.size,
        compression: 'snappy',
        format: 'parquet',
        partitionStrategy: 'year-based',
        etag: uploadResult.ETag
      };
    } catch (error) {
      console.error('S3 Parquet archive error:', error);
      throw new Error(`S3 Parquet archive failed: ${error.message}`);
    } finally {
      // Always clean up temporary file, whether success or failure
      this.cleanupTempFile(tempFilePath, true); // suppressLogs = true for cleaner output
    }
  }

  /**
   * Build base prefix for table (without year partition)
   * Used for broad queries across all years
   */
  buildBasePrefix(tableName) {
    const tablePrefix = this.getTablePrefix(tableName);
    const prefix = tablePrefix.toLowerCase();
    const table = tableName.toLowerCase();
    
    // Check for redundancy patterns
    const isRedundant = (
      // Direct match: "weather-reports/" + "weather_reports"
      (prefix.includes('weather') && table.includes('weather')) ||
      // Or if prefix ends with table name pattern
      (prefix.replace(/[-_]/g, '').includes(table.replace(/[-_]/g, '')))
    );
    
    if (isRedundant) {
      // Skip table name to avoid duplication
      return tablePrefix;
    } else {
      // Standard path: prefix + table
      return `${tablePrefix}${tableName}/`;
    }
  }

  /**
   * Build partition path with smart redundancy detection
   * Avoids duplicate naming like "weather-reports/weather_reports/"
   */
  buildPartitionPath(tableName, year) {
    const basePrefix = this.buildBasePrefix(tableName);
    const fullPath = `${basePrefix}year=${year}/`;
    
    // Log only when redundancy is detected
    if (basePrefix === this.getTablePrefix(tableName)) {
      // redundancy detected; using compact base prefix
    }
    
    return fullPath;
  }

  /**
   * Auto-detect year from data based on created_at field
   */
  detectYearFromData(data) {
    if (!data || data.length === 0) {
      return new Date().getFullYear();
    }

    // Prefer submission_date when available (e.g., project_hours)
    for (const record of data) {
      if (record.submission_date) {
        const sd = this.safeMoment(record.submission_date);
        if (sd) {
          return sd.year();
        }
      }
      if (record.created_at) {
        const date = this.safeMoment(record.created_at);
        if (date) {
          return date.year();
        }
      }
    }

    // Fallback to current year if no valid date found
    return new Date().getFullYear();
  }

  /**
   * Transform a database record for Parquet format
   * Handles data type conversions and adds year-based partition metadata
   */
  transformRecordForParquet(record, year, archiveTimestamp) {
    const transformed = { ...record };

    // Convert date strings to proper Date objects for TIMESTAMP_MILLIS
    Object.keys(transformed).forEach(key => {
      const value = transformed[key];
      const lowerKey = String(key).toLowerCase();
      
      // Convert created_at/updated_at using row timezone to UTC
      if ((key === 'created_at' || key === 'updated_at')) {
        const tz = (transformed.timezone && String(transformed.timezone)) || 'America/Los_Angeles';
        if (value) {
          try {
            const m = moment.tz(value, tz);
            if (m.isValid()) {
              transformed[key] = m.utc().toDate();
            }
          } catch (_) {
            transformed[key] = new Date(value);
          }
        }
      } else if (key === 'submission_date' && value) {
          const m = this.safeMoment(value);
          if (m) {
            const epochMoment = moment('1970-01-01');
            const daysSinceEpoch = m.startOf('day').diff(epochMoment, 'days');
            transformed[key] = daysSinceEpoch;
          } else {
            const fallbackMoment = moment(value);
            if (fallbackMoment.isValid()) {
              const epochMoment = moment('1970-01-01');
              const daysSinceEpoch = fallbackMoment.startOf('day').diff(epochMoment, 'days');
              transformed[key] = daysSinceEpoch;
          }
        }
      } 
      else if ((lowerKey.includes('date') || lowerKey.includes('time')) && lowerKey !== 'timezone') {
        if (typeof value === 'string') {
          transformed[key] = new Date(value);
        } else if (moment.isMoment(value)) {
          transformed[key] = value.toDate();
        }
      }
      
      if ((key === 'id' || key.endsWith('_id')) && typeof value === 'string') {
        transformed[key] = parseInt(value, 10);
      }
    });

    // Add archive metadata (year-based partitioning)
    transformed.archive_year = year;
    transformed.archive_date = archiveTimestamp;

    // Normalize timezone to string if present
    if (transformed.timezone !== undefined && transformed.timezone !== null) {
      transformed.timezone = String(transformed.timezone);
    }

    return transformed;
  }

  /**
   * Query archived data from S3 Parquet files
   * For optimal performance, consider using AWS Athena for complex queries
   */
  async queryArchivedData(tableName, filters = {}, options = {}) {
    try {
      // Querying archived Parquet data

      const listParams = {
        Bucket: this.bucket,
        Prefix: this.buildBasePrefix(tableName)
      };

      // Add year-based partition filtering if date range is specified
      if (filters.startDate || filters.endDate) {
        // date filtering requested
        const yearRanges = this.getYearRanges(filters.startDate, filters.endDate);
        if (yearRanges.length === 1) {
          listParams.Prefix = this.buildPartitionPath(tableName, yearRanges[0]);
          // single year partition optimization
        } else {
          // multi-year query across several years
        }
      }

      // List Parquet objects in the archive
      const listResponse = await this.s3.listObjectsV2(listParams).promise();
      
      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        return {
          success: true,
          data: [],
          source: 's3-archive-parquet',
          totalCount: 0
        };
      }

      // Filter for Parquet files only and by date if needed
      const parquetObjects = listResponse.Contents.filter(obj => 
        obj.Key.endsWith('.parquet')
      );
      
      const relevantObjects = this.filterObjectsByDate(parquetObjects, filters);

      // files to query count

      // For large datasets, suggest using Athena
      if (relevantObjects.length > 10) {
        console.log(`Large dataset detected (${relevantObjects.length} files). Consider using AWS Athena for better performance.`);
      }

      // Retrieve and combine data from relevant Parquet objects
      const allData = [];
      
      for (const obj of relevantObjects) {
        try {
          const objData = await this.getParquetObjectData(obj.Key);
          if (objData && objData.length > 0) {
            // Apply additional filters to the data
            const filteredData = this.applyDataFilters(objData, filters);
            allData.push(...filteredData);
          }
        } catch (error) {
          console.error(`Error reading Parquet file ${obj.Key}:`, error.message);
          // Continue with other files
        }
      }

      // Apply sorting and pagination
      const processedData = this.processResults(allData, options);

      console.log(`Retrieved ${allData.length} records from ${relevantObjects.length} Parquet files`);

      return {
        success: true,
        data: processedData,
        source: 's3-archive-parquet',
        totalCount: allData.length,
        objectsQueried: relevantObjects.length,
        suggestion: relevantObjects.length > 10 ? 'Consider using AWS Athena for better performance on large datasets' : null
      };
    } catch (error) {
      console.error('S3 Parquet query error:', error);
      throw new Error(`S3 Parquet query failed: ${error.message}`);
    }
  }

  /**
   * Get Parquet object data from S3 (new method)
   */
  async getParquetObjectData(key) {
    let tempFilePath = null;
    
    try {
      // Download Parquet file to temporary location
      tempFilePath = path.join(this.tempDir, `temp_${Date.now()}.parquet`);
      
      const params = {
        Bucket: this.bucket,
        Key: key
      };

      const response = await this.s3.getObject(params).promise();
      fs.writeFileSync(tempFilePath, response.Body);

      // Read Parquet file
      const reader = await parquet.ParquetReader.openFile(tempFilePath);
      const cursor = reader.getCursor();
      
      const records = [];
      let record = null;
      
      while (record = await cursor.next()) {
        // Convert timestamps back to proper format
        const processedRecord = this.processParquetRecord(record);
        records.push(processedRecord);
      }

      await reader.close();

      return records;
    } catch (error) {
      console.error(`Error retrieving Parquet object ${key}:`, error);
      return [];
    } finally {
      // Always clean up temporary file
      this.cleanupTempFile(tempFilePath, true);
    }
  }

  /**
   * Get object data from S3 (legacy JSON support)
   */
  async getObjectData(key) {
    try {
      // Check if it's a Parquet file
      if (key.endsWith('.parquet')) {
        return await this.getParquetObjectData(key);
      }

      const params = {
        Bucket: this.bucket,
        Key: key
      };

      const response = await this.s3.getObject(params).promise();
      const jsonData = JSON.parse(response.Body.toString());
      
      // Handle legacy JSON format
      return jsonData.data || jsonData;
    } catch (error) {
      console.error(`Error retrieving object ${key}:`, error);
      return null;
    }
  }

  /**
   * Process Parquet record (convert timestamps, etc.)
   */
  processParquetRecord(record) {
    const processed = { ...record };

    // Convert timestamp fields back to ISO strings for consistency
    Object.keys(processed).forEach(key => {
      const value = processed[key];
      
      if (value instanceof Date) {
        processed[key] = value.toISOString();
      }
    });

    // Remove archive metadata fields for clean data return
    delete processed.archive_year;
    delete processed.archive_date;

    return processed;
  }

  /**
   * Filter archived data by criteria
   */
  applyDataFilters(data, filters) {
    let filteredData = [...data];

    // Date range filtering
    if (filters.startDate) {
      const startMoment = this.safeMoment(filters.startDate);
      if (startMoment) {
        filteredData = filteredData.filter(record => {
          const recordMoment = this.safeMoment(record.created_at);
          return recordMoment && recordMoment.isSameOrAfter(startMoment);
        });
      }
    }

    if (filters.endDate) {
      const endMoment = this.safeMoment(filters.endDate);
      if (endMoment) {
        filteredData = filteredData.filter(record => {
          const recordMoment = this.safeMoment(record.created_at);
          return recordMoment && recordMoment.isSameOrBefore(endMoment);
        });
      }
    }

    // Custom filtering (you can extend this)
    if (filters.customFilter && typeof filters.customFilter === 'function') {
      filteredData = filteredData.filter(filters.customFilter);
    }

    return filteredData;
  }

  /**
   * Process results with sorting and pagination
   */
  processResults(data, options) {
    let processedData = [...data];

    // Sorting
    if (options.orderBy) {
      processedData.sort((a, b) => {
        const aVal = a[options.orderBy];
        const bVal = b[options.orderBy];
        
        if (options.orderDirection === 'DESC') {
          return bVal > aVal ? 1 : -1;
        } else {
          return aVal > bVal ? 1 : -1;
        }
      });
    }

    // Pagination
    if (options.offset || options.limit) {
      const start = options.offset || 0;
      const end = options.limit ? start + options.limit : undefined;
      processedData = processedData.slice(start, end);
    }

    return processedData;
  }

  /**
   * Pre-validate date input to avoid moment.js errors entirely
   */
  isValidDateInput(dateInput) {
    // Check for null, undefined, empty values
    if (!dateInput || dateInput === 'undefined' || dateInput === 'null') {
      return false;
    }
    
    // Check for problematic string values
    if (typeof dateInput === 'string') {
      const trimmed = dateInput.trim();
      if (trimmed === '' || trimmed === 'Invalid date' || trimmed === 'NaN' || 
          trimmed.includes('invalid') || trimmed.includes('Invalid')) {
        return false;
      }
      
      // Basic date format check (YYYY-MM-DD or similar)
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
    // Pre-validate to avoid calling moment() with problematic inputs
    if (!this.isValidDateInput(dateInput)) {
      return null;
    }
    
    try {
      const momentObj = moment(dateInput);
      return momentObj.isValid() ? momentObj : null;
    } catch (error) {
      console.warn(`⚠️  Moment parsing error for "${dateInput}":`, error.message);
      return null;
    }
  }

  /**
   * Get year ranges for date filtering (simplified year-based partitioning)
   */
  getYearRanges(startDate, endDate) {
    const years = [];
    const currentYear = moment().year();
    const cutoffYear = moment().subtract(this.archiveThresholdYears || 2, 'years').year();
    
    // Safely parse start date
    const startMoment = this.safeMoment(startDate);
    if (!startMoment) {
      console.warn(`Invalid startDate: ${startDate}, using archive cutoff year`);
      // Use fallback range from cutoff to current year
      for (let year = cutoffYear; year <= currentYear; year++) {
        years.push(year);
      }
      return years;
    }
    
    // Safely parse end date
    const endMoment = this.safeMoment(endDate);
    if (!endMoment) {
      console.warn(`Invalid endDate: ${endDate}, using current year`);
      // Use range from valid start to current year
      const startYear = startMoment.year();
      for (let year = startYear; year <= currentYear; year++) {
        years.push(year);
      }
      return years;
    }
    
    const startYear = startMoment.year();
    const endYear = endMoment.year();
    
    // Ensure start year is not after end year
    if (startYear > endYear) {
      console.warn(`startYear (${startYear}) is after endYear (${endYear}), swapping dates`);
      for (let year = endYear; year <= startYear; year++) {
        years.push(year);
      }
    } else {
      for (let year = startYear; year <= endYear; year++) {
        years.push(year);
      }
    }
    
    // year ranges selected for query
    return years;
  }

  /**
   * Build partition prefix for S3 listing (year-based)
   */
  buildPartitionPrefix(tableName, yearRanges) {
    if (yearRanges.length === 1) {
      return `${this.getTablePrefix(tableName)}${tableName}/year=${yearRanges[0]}/`;
    }
    
    // For multiple year ranges, use the base table prefix
    return `${this.getTablePrefix(tableName)}${tableName}/`;
  }

  /**
   * Filter S3 objects by date metadata (year-based partitioning)
   */
  filterObjectsByDate(objects, filters) {
    if (!filters.startDate && !filters.endDate) {
      return objects;
    }

    return objects.filter(obj => {
      // Extract year from object key: year=2021/
      const keyMatch = obj.Key.match(/year=(\d{4})/);
      if (!keyMatch) return true;

      const objYear = parseInt(keyMatch[1]);

      if (filters.startDate) {
        const startMoment = this.safeMoment(filters.startDate);
        if (startMoment && objYear < startMoment.year()) {
          return false;
        }
      }

      if (filters.endDate) {
        const endMoment = this.safeMoment(filters.endDate);
        if (endMoment && objYear > endMoment.year()) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Get count of archived records
   */
  async getArchivedCount(tableName, filters = {}) {
    try {
      const result = await this.queryArchivedData(tableName, filters, { countOnly: true });
      return result.totalCount;
    } catch (error) {
      console.error('S3 count error:', error);
      throw new Error(`S3 count failed: ${error.message}`);
    }
  }

  /**
   * Filter date range for archived data only
   */
  filterForArchivedData(startDate, endDate) {
    const cutoffDate = moment().subtract(2, 'years').format('YYYY-MM-DD HH:mm:ss');
    const endMoment = this.safeMoment(endDate);
    const cutoffMoment = moment(cutoffDate);
    
    let finalEndDate = endDate;
    if (endMoment) {
      finalEndDate = moment.min(endMoment, cutoffMoment).format('YYYY-MM-DD HH:mm:ss');
    }
    
    return {
      startDate: startDate,
      endDate: finalEndDate
    };
  }

  /**
   * Generate AWS Athena CREATE TABLE statement for year-partitioned Parquet data
   * This enables efficient querying of archived data with SQL
   */
  generateAthenaTableDDL(tableName, databaseName = 'weather_archive') {
    const location = `s3://${this.bucket}/${this.getTablePrefix(tableName)}${tableName}/`;
    
    if (tableName === 'weather_reports') {
      return `
CREATE EXTERNAL TABLE IF NOT EXISTS ${databaseName}.${tableName}_archive (
  id bigint,
  project_id int,
  quarter string,
  created_at timestamp,
  updated_at timestamp,
  day_forecast string
)
PARTITIONED BY (
  archive_year int
)
STORED AS PARQUET
LOCATION '${location}'
TBLPROPERTIES (
  'has_encrypted_data'='false',
  'projection.enabled'='true',
  'projection.archive_year.type'='integer',
  'projection.archive_year.range'='2020,2030',
  'storage.location.template'='${location}year=\${archive_year}/'
);

-- Add partitions (run this after the table is created)
MSCK REPAIR TABLE ${databaseName}.${tableName}_archive;
      `.trim();
    }

    if (tableName === 'project_hours') {
      return `
CREATE EXTERNAL TABLE IF NOT EXISTS ${databaseName}.${tableName}_archive (
  id bigint,
  project_id bigint,
  user_id bigint,
  name string,
  quantity bigint,
  hours double,
  total_hours double,
  description string,
  submission_date date,
  to_delete int,
  has_no_work int,
  created_at timestamp,
  updated_at timestamp
)
PARTITIONED BY (
  archive_year int
)
STORED AS PARQUET
LOCATION '${location}'
TBLPROPERTIES (
  'has_encrypted_data'='false',
  'projection.enabled'='true',
  'projection.archive_year.type'='integer',
  'projection.archive_year.range'='2020,2035',
  'storage.location.template'='${location}year=\${archive_year}/'
);

-- Add partitions (run this after the table is created)
MSCK REPAIR TABLE ${databaseName}.${tableName}_archive;
      `.trim();
    }

    // Generic table DDL for other tables (year-partitioned)
    return `
-- Generic year-partitioned Parquet table DDL for ${tableName}
-- Please customize the column definitions based on your table structure
CREATE EXTERNAL TABLE IF NOT EXISTS ${databaseName}.${tableName}_archive (
  -- Add your column definitions here
  id bigint,
  created_at timestamp
  -- ... other columns
)
PARTITIONED BY (
  archive_year int
)
STORED AS PARQUET
LOCATION '${location}'
TBLPROPERTIES (
  'has_encrypted_data'='false',
  'projection.enabled'='true',
  'projection.archive_year.type'='integer',
  'projection.archive_year.range'='2020,2030',
  'storage.location.template'='${location}year=\${archive_year}/'
);
    `.trim();
  }

  /**
   * Get Parquet file statistics
   */
  async getParquetStats(tableName) {
    try {
      const listParams = {
        Bucket: this.bucket,
        Prefix: `${this.getTablePrefix(tableName)}${tableName}/`
      };

      const listResponse = await this.s3.listObjectsV2(listParams).promise();
      const parquetFiles = listResponse.Contents?.filter(obj => obj.Key.endsWith('.parquet')) || [];

      const stats = {
        totalFiles: parquetFiles.length,
        totalSize: parquetFiles.reduce((sum, file) => sum + file.Size, 0),
        avgFileSize: 0,
        oldestFile: null,
        newestFile: null,
        compressionRatio: 'N/A' // Would need original JSON size to calculate
      };

      if (parquetFiles.length > 0) {
        stats.avgFileSize = Math.round(stats.totalSize / parquetFiles.length);
        stats.oldestFile = parquetFiles.reduce((oldest, file) => 
          file.LastModified < oldest.LastModified ? file : oldest
        ).LastModified;
        stats.newestFile = parquetFiles.reduce((newest, file) => 
          file.LastModified > newest.LastModified ? file : newest
        ).LastModified;
      }

      return stats;
    } catch (error) {
      console.error('Error getting Parquet stats:', error);
      throw error;
    }
  }

  /**
   * Cleanup temporary files (maintenance method)
   */
  cleanupTempFiles() {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        const now = Date.now();
        const maxAge = 3600000; // 1 hour

        files.forEach(file => {
          const filePath = path.join(this.tempDir, file);
          const stats = fs.statSync(filePath);
          
          if (now - stats.mtime.getTime() > maxAge) {
            fs.unlinkSync(filePath);
          }
        });
      }
    } catch (error) {
      console.error('Error cleaning up temp files:', error);
    }
  }
}

module.exports = S3ArchiveService;

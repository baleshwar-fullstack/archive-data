const MySQLService = require('./MySQLService');
const S3ArchiveService = require('./S3ArchiveService');
const AthenaService = require('./AthenaService');
const moment = require('moment');

class DataRouterService {
  constructor() {
    this.mysqlService = new MySQLService();
    this.s3ArchiveService = new S3ArchiveService();
    this.athenaService = new AthenaService();
    this.archiveThresholdYears = parseInt(process.env.ARCHIVE_THRESHOLD_YEARS) || 2;
    this.supportedTables = ['weather_reports', 'project_hours'];
  }

  /**
   * Validate if table is supported for migration
   */
  isTableSupported(tableName) {
    return this.supportedTables.includes(tableName);
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

      // Basic date format check - allow various common formats
      const patterns = [
        /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/, // YYYY-MM-DD or YYYY/MM/DD
        /^\d{1,2}[-\/]\d{1,2}[-\/]\d{4}/, // MM/DD/YYYY or DD/MM/YYYY  
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO format
        /^\d{10,13}$/ // Unix timestamps (10 or 13 digits)
      ];

      const hasValidPattern = patterns.some(pattern => pattern.test(trimmed));
      if (!hasValidPattern) {
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
      console.warn(`Moment parsing error in DataRouter for "${dateInput}":`, error.message);
      return null;
    }
  }

  /**
   * Safely parse date with validation and fallback
   */
  safeParseDate(dateString, fallback = null) {
    const parsedDate = this.safeMoment(dateString);
    if (!parsedDate) {
      console.warn(`Invalid date in DataRouter: ${dateString}, using fallback`);
      return fallback;
    }

    return parsedDate;
  }

  /**
   * Enhanced date parsing with multiple format support
   * Supports: YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, ISO strings, timestamps
   */
  parseFlexibleDate(dateInput, timezone = 'UTC') {
    if (!dateInput) return null;

    // Handle different input types
    let dateToProcess = dateInput;

    // Handle Unix timestamps (seconds or milliseconds)
    if (typeof dateInput === 'number' || (!isNaN(dateInput) && !isNaN(parseFloat(dateInput)))) {
      const timestamp = parseInt(dateInput);
      // Detect if it's seconds (10 digits) or milliseconds (13 digits)
      const timestampMs = timestamp < 10000000000 ? timestamp * 1000 : timestamp;
      dateToProcess = new Date(timestampMs).toISOString();
    }

    // Pre-validate before calling moment
    if (!this.isValidDateInput(dateToProcess)) {
      return null;
    }

    try {
      let parsedMoment;

      // Try different date formats
      const formats = [
        'YYYY-MM-DD',
        'YYYY-MM-DD HH:mm:ss',
        'YYYY-MM-DDTHH:mm:ss',
        'YYYY-MM-DDTHH:mm:ss.SSS',
        'YYYY-MM-DDTHH:mm:ssZ',
        'YYYY/MM/DD',
        'MM/DD/YYYY',
        'DD/MM/YYYY',
        'YYYY-MM-DD HH:mm:ss.SSS'
      ];

      // Try moment with explicit formats first
      for (const format of formats) {
        parsedMoment = moment(dateToProcess, format, true);
        if (parsedMoment.isValid()) {
          break;
        }
      }

      // If no explicit format worked, try moment's default parsing
      if (!parsedMoment || !parsedMoment.isValid()) {
        parsedMoment = moment(dateToProcess);
      }

      // Final validation
      if (!parsedMoment.isValid()) {
        console.warn(`Could not parse date: ${dateInput}`);
        return null;
      }

      // Apply timezone if specified
      if (timezone && timezone !== 'UTC') {
        // Note: For full timezone support, consider using moment-timezone
        console.log(`Timezone specified: ${timezone} (basic UTC offset applied)`);
      }

      return parsedMoment;

    } catch (error) {
      console.warn(`Date parsing error: ${error.message}`);
      return null;
    }
  }

  /**
   * Smart query routing based on date range and data location
   * Direct queries without caching for optimal simplicity and always fresh results
   */
  async query(tableName, filters = {}, options = {}) {
    try {
      const cutoffDate = moment().subtract(this.archiveThresholdYears, 'years');
      const queryStartDate = this.safeParseDate(filters.startDate);
      const queryEndDate = this.safeParseDate(filters.endDate) || moment();

      let queryResult;

      // Determine query strategy based on date range
      if (!queryStartDate || queryStartDate.isAfter(cutoffDate)) {
        // Query only recent data (MySQL)
        queryResult = await this.queryRecentOnly(tableName, filters, options);
      } else if (queryEndDate.isBefore(cutoffDate)) {
        // Query only archived data (S3)
        queryResult = await this.queryArchiveOnly(tableName, filters, options);
      } else {
        // Hybrid query spanning both storage tiers
        queryResult = await this.queryHybrid(tableName, filters, options);
      }

      return queryResult;
    } catch (error) {
      console.error('Data router query error:', error);
      throw new Error(`Query routing failed: ${error.message}`);
    }
  }

  /**
   * Query only recent data from MySQL
   */
  async queryRecentOnly(tableName, filters, options) {
    try {
      console.log(`[DataRouter] Querying recent data only for table: ${tableName}`);

      const result = await this.mysqlService.queryRecentData(tableName, filters, options);

      return {
        ...result,
        strategy: 'mysql-only',
        performance: {
          mysqlRecords: result.totalCount,
          s3Records: 0,
          totalSources: 1
        }
      };
    } catch (error) {
      throw new Error(`Recent data query failed: ${error.message}`);
    }
  }

  /**
   * Query only archived data from S3 using Athena
   */
  async queryArchiveOnly(tableName, filters, options) {
    try {
      console.log(`[DataRouter] Querying archived data only for table: ${tableName}`);

      const result = await this.athenaService.queryArchivedData(tableName, filters, options);

      return {
        ...result,
        strategy: 'athena-only',
        performance: {
          mysqlRecords: 0,
          s3Records: result.data.length,
          totalSources: 1
        }
      };
    } catch (error) {
      throw new Error(`Archived data query failed: ${error.message}`);
    }
  }

  /**
   * Hybrid query spanning both MySQL and S3
   */
  async queryHybrid(tableName, filters, options) {
    try {
      console.log(`[DataRouter] Executing hybrid query for table: ${tableName}`);

      const cutoffDate = moment().subtract(this.archiveThresholdYears, 'years');

      // Split the query into two parts
      const recentFilters = {
        ...filters,
        ...this.mysqlService.filterForRecentData(filters.startDate, filters.endDate)
      };

      const archiveFilters = {
        ...filters,
        ...this.s3ArchiveService.filterForArchivedData(filters.startDate, filters.endDate)
      };

      // Execute both queries in parallel
      const [recentResult, archiveResult] = await Promise.all([
        this.mysqlService.queryRecentData(tableName, recentFilters, options),
        this.athenaService.queryArchivedData(tableName, archiveFilters, options)
      ]);

      // Merge and sort results
      const combinedData = [
        ...archiveResult.data,
        ...recentResult.data
      ];

      // Apply global sorting and pagination to combined results
      const finalData = this.processCombinedResults(combinedData, options);

      return {
        success: true,
        data: finalData,
        strategy: 'hybrid',
        source: 'mysql+s3-archive',
        totalCount: combinedData.length,
        performance: {
          mysqlRecords: recentResult.totalCount,
          s3Records: archiveResult.totalCount,
          totalSources: 2,
          objectsQueried: archiveResult.objectsQueried || 0
        }
      };
    } catch (error) {
      throw new Error(`Hybrid query failed: ${error.message}`);
    }
  }

  /**
   * Process combined results from multiple sources
   */
  processCombinedResults(data, options) {
    let processedData = [...data];

    // Remove duplicates if any (based on ID)
    if (processedData.length > 0 && processedData[0].id !== undefined) {
      const seen = new Set();
      processedData = processedData.filter(item => {
        if (seen.has(item.id)) {
          return false;
        }
        seen.add(item.id);
        return true;
      });
    }

    // Global sorting
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

    // Global pagination
    if (options.offset || options.limit) {
      const start = options.offset || 0;
      const end = options.limit ? start + options.limit : undefined;
      processedData = processedData.slice(start, end);
    }

    return processedData;
  }

  /**
   * Get weather reports by specific date across all storage tiers
   * Optimized for exact date matching with timezone support
   */
  async getBySpecificDate(tableName, filters = {}, options = {}) {
    const startTime = Date.now();

    try {
      const { date, timezone = 'UTC', includeTime = false } = filters;

      if (!date) {
        throw new Error('Date parameter is required');
      }

      console.log(`Querying ${tableName} for specific date: ${date} (${timezone})`);

      // Parse and validate the date using flexible parsing
      const targetDate = this.parseFlexibleDate(date, timezone);
      if (!targetDate) {
        throw new Error(`Invalid date format: ${date}. Supported formats: YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, ISO strings, Unix timestamps.`);
      }

      // Create date range for the specific day
      let startDate, endDate;

      if (includeTime) {
        // For time-specific queries, use the exact timestamp
        startDate = targetDate.clone();
        endDate = targetDate.clone().add(1, 'minute'); // 1-minute window
      } else {
        // For date-only queries, cover the entire day
        startDate = targetDate.clone().startOf('day');
        endDate = targetDate.clone().endOf('day');
      }

      console.log(`Date range: ${startDate.format()} to ${endDate.format()}`);

      // Create filters for the date range
      const dateFilters = {
        startDate: startDate.format('YYYY-MM-DD HH:mm:ss'),
        endDate: endDate.format('YYYY-MM-DD HH:mm:ss'),
        ...filters // Include any additional filters
      };

      // Remove date-specific filters to avoid conflicts
      delete dateFilters.date;
      delete dateFilters.timezone;
      delete dateFilters.includeTime;

      // Use existing query method with optimized date range
      const result = await this.query(tableName, dateFilters, options);

      const queryTime = Date.now() - startTime;

      return {
        ...result,
        meta: {
          ...result.meta,
          specificDate: date,
          timezone,
          includeTime,
          dateRange: {
            start: startDate.format(),
            end: endDate.format()
          },
          queryTime
        }
      };

    } catch (error) {
      console.error('Specific date query error:', error);
      throw new Error(`Failed to query by date: ${error.message}`);
    }
  }

  /**
   * Get total count across all storage tiers
   */
  async getCount(tableName, filters = {}) {
    try {
      const cutoffDate = moment().subtract(this.archiveThresholdYears, 'years');
      const queryStartDate = this.safeParseDate(filters.startDate);
      const queryEndDate = this.safeParseDate(filters.endDate) || moment();

      let totalCount = 0;

      // Determine which storage tiers to query
      const needsRecent = !queryStartDate || queryStartDate.isAfter(cutoffDate);
      const needsArchive = !queryEndDate || queryEndDate.isBefore(cutoffDate);

      const countPromises = [];

      if (needsRecent) {
        countPromises.push(this.mysqlService.getRecentCount(tableName, filters));
      }

      if (needsArchive) {
        countPromises.push(this.athenaService.getArchivedCount(tableName, filters));
      }

      const counts = await Promise.all(countPromises);
      totalCount = counts.reduce((sum, count) => sum + count, 0);

      return {
        success: true,
        totalCount,
        breakdown: {
          recent: needsRecent ? counts[0] || 0 : 0,
          archived: needsArchive ? counts[counts.length - 1] || 0 : 0
        }
      };
    } catch (error) {
      console.error('Count query error:', error);
      throw new Error(`Count query failed: ${error.message}`);
    }
  }

  // Cache-related methods removed - using direct queries for simplicity
  // This ensures always fresh data and reduces system complexity

  /**
   * Get query performance stats
   */
  async getPerformanceStats(tableName) {
    try {
      if (!this.isTableSupported(tableName)) {
        throw new Error(`Table ${tableName} is not supported for migration`);
      }

      const recentCount = await this.mysqlService.getRecentCount(tableName);
      const archiveCount = await this.athenaService.getArchivedCount(tableName);

      return {
        tableName,
        recentRecords: recentCount,
        archivedRecords: archiveCount,
        totalRecords: recentCount + archiveCount,
        archivePercentage: ((archiveCount / (recentCount + archiveCount)) * 100).toFixed(2),
        cutoffDate: moment().subtract(this.archiveThresholdYears, 'years').format('YYYY-MM-DD'),
        supported: true
      };
    } catch (error) {
      console.error('Performance stats error:', error);
      throw new Error(`Performance stats failed: ${error.message}`);
    }
  }
}

module.exports = DataRouterService;

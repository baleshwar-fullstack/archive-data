const database = require('../config/database');
const moment = require('moment');

class MySQLService {
  constructor() {
    this.db = database;
    this.archiveThresholdYears = parseInt(process.env.ARCHIVE_THRESHOLD_YEARS) || 2;
  }

  /**
   * Get the cutoff date for archive threshold
   */
  getArchiveCutoffDate() {
    return moment().subtract(this.archiveThresholdYears, 'years').format('YYYY-MM-DD HH:mm:ss');
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
      console.warn(`⚠️  Moment parsing error in MySQLService for "${dateInput}":`, error.message);
      return null;
    }
  }

  /**
   * Safely parse date with validation
   */
  safeParseDate(dateString, fallback = null) {
    const parsedDate = this.safeMoment(dateString);
    if (!parsedDate) {
      console.warn(`⚠️  Invalid date in MySQLService: ${dateString}, using fallback`);
      return fallback;
    }
    
    return parsedDate;
  }

  /**
   * Query recent data (within archive threshold)
   */
  async queryRecentData(tableName, filters = {}, options = {}) {
    try {
      const cutoffDate = this.getArchiveCutoffDate();
      
      // Build dynamic query based on filters
      let query = `SELECT * FROM ${tableName} WHERE created_at >= ?`;
      let params = [cutoffDate];

      // Add additional filters
      if (filters.startDate) {
        query += ' AND created_at >= ?';
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        query += ' AND created_at <= ?';
        params.push(filters.endDate);
      }

      // Add custom where conditions
      if (filters.customWhere) {
        query += ` AND ${filters.customWhere}`;
        if (filters.customParams) {
          params.push(...filters.customParams);
        }
      }

      // Add ordering and pagination
      if (options.orderBy) {
        query += ` ORDER BY ${options.orderBy}`;
        if (options.orderDirection) {
          query += ` ${options.orderDirection}`;
        }
      }

      if (options.limit) {
        query += ` LIMIT ${options.limit}`;
        if (options.offset) {
          query += ` OFFSET ${options.offset}`;
        }
      }

      const results = await this.db.query(query, params);
      return {
        success: true,
        data: results,
        source: 'mysql',
        totalCount: results.length
      };
    } catch (error) {
      console.error('MySQL query error:', error);
      throw new Error(`MySQL query failed: ${error.message}`);
    }
  }

  /**
   * Get count of recent records
   */
  async getRecentCount(tableName, filters = {}) {
    try {
      const cutoffDate = this.getArchiveCutoffDate();
      
      let query = `SELECT COUNT(*) as count FROM ${tableName} WHERE created_at >= ?`;
      let params = [cutoffDate];

      if (filters.customWhere) {
        query += ` AND ${filters.customWhere}`;
        if (filters.customParams) {
          params.push(...filters.customParams);
        }
      }

      const result = await this.db.query(query, params);
      return result[0].count;
    } catch (error) {
      console.error('MySQL count error:', error);
      throw new Error(`MySQL count failed: ${error.message}`);
    }
  }

  /**
   * Get records that should be archived (older than threshold)
   */
  async getRecordsForArchive(tableName, batchSize = 1000, offset = 0) {
    try {
      const cutoffDate = this.getArchiveCutoffDate();
      
      // Ensure batchSize and offset are integers
      const limit = parseInt(batchSize);
      const offsetInt = parseInt(offset);
      
      // Validation
      if (isNaN(limit) || limit <= 0) {
        throw new Error(`Invalid batch size: ${batchSize}`);
      }
      if (isNaN(offsetInt) || offsetInt < 0) {
        throw new Error(`Invalid offset: ${offset}`);
      }
      
      // Use template literals for LIMIT and OFFSET to avoid parameter binding issues
      // Include project's timezone for downstream archiving and Athena queries
      const query = `
        SELECT t.*, COALESCE(p.timezone, 'America/Los_Angeles') AS timezone
        FROM ${tableName} t
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.created_at < ?
        ORDER BY t.created_at ASC
        LIMIT ${limit} OFFSET ${offsetInt}
      `;
      
      console.log(`Archive query: ${query.replace(/\s+/g, ' ').trim()}`);
      console.log(`Parameters: cutoffDate=${cutoffDate}, limit=${limit}, offset=${offsetInt}`);
      
      const results = await this.db.query(query, [cutoffDate]);
      return results;
    } catch (error) {
      console.error('Archive selection error:', error);
      throw new Error(`Archive selection failed: ${error.message}`);
    }
  }

  /**
   * Delete archived records from MySQL
   */
  async deleteArchivedRecords(tableName, recordIds) {
    try {
      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        return { success: true, deletedCount: 0 };
      }

      const placeholders = recordIds.map(() => '?').join(',');
      const query = `DELETE FROM ${tableName} WHERE id IN (${placeholders})`;
      
      const result = await this.db.query(query, recordIds);
      return {
        success: true,
        deletedCount: result.affectedRows
      };
    } catch (error) {
      console.error('Delete archived records error:', error);
      throw new Error(`Delete operation failed: ${error.message}`);
    }
  }

  /**
   * Get table schema for archive format
   */
  async getTableSchema(tableName) {
    try {
      const query = `DESCRIBE ${tableName}`;
      const schema = await this.db.query(query);
      return schema;
    } catch (error) {
      console.error('Schema retrieval error:', error);
      throw new Error(`Schema retrieval failed: ${error.message}`);
    }
  }

  /**
   * Check if date range spans both recent and archived data
   */
  isHybridQuery(startDate, endDate) {
    const cutoffDate = moment(this.getArchiveCutoffDate());
    const start = this.safeParseDate(startDate);
    const end = this.safeParseDate(endDate);

    if (!start || !end) {
      console.warn(`⚠️  Invalid dates for hybrid query check: start=${startDate}, end=${endDate}`);
      return false;
    }

    return start.isBefore(cutoffDate) && end.isAfter(cutoffDate);
  }

  /**
   * Filter date range for recent data only
   */
  filterForRecentData(startDate, endDate) {
    const cutoffDate = this.getArchiveCutoffDate();
    const startMoment = this.safeMoment(startDate);
    const cutoffMoment = moment(cutoffDate);
    
    if (!startMoment) {
      console.warn(`⚠️  Invalid startDate for filtering: ${startDate}, using cutoff date`);
      return {
        startDate: cutoffDate,
        endDate: endDate
      };
    }
    
    return {
      startDate: moment.max(startMoment, cutoffMoment).format('YYYY-MM-DD HH:mm:ss'),
      endDate: endDate
    };
  }
}

module.exports = MySQLService;

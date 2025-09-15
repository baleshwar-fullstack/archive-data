const DataRouterService = require('../services/DataRouterService');
const Joi = require('joi');

class DataController {
  constructor() {
    this.dataRouter = new DataRouterService();
  }

  /**
   * Query data across all storage tiers
   */
  async queryData(req, res) {
    try {
      // Validate request parameters
      const validation = this.validateQueryParams(req.query);
      if (validation.error) {
        return res.status(400).json({
          success: false,
          error: 'Invalid query parameters',
          details: validation.error.details
        });
      }

      const { tableName } = req.params;
      const { startDate, endDate, limit, offset, orderBy, orderDirection, useCache } = req.query;

      // Build filters and options
      const filters = {
        startDate: startDate || null,
        endDate: endDate || null
      };

      const options = {
        limit: limit ? parseInt(limit) : null,
        offset: offset ? parseInt(offset) : null,
        orderBy: orderBy || 'created_at',
        orderDirection: orderDirection || 'DESC',
        useCache: useCache !== 'false'
      };

      // Add any custom filters from request body
      if (req.body && req.body.customFilters) {
        filters.customWhere = req.body.customFilters.where;
        filters.customParams = req.body.customFilters.params;
      }

      const startTime = Date.now();
      const result = await this.dataRouter.query(tableName, filters, options);
      const queryTime = Date.now() - startTime;

      res.json({
        success: true,
        ...result,
        meta: {
          queryTime: `${queryTime}ms`,
          timestamp: new Date().toISOString(),
          pagination: {
            limit: options.limit,
            offset: options.offset,
            hasMore: result.data.length === options.limit
          }
        }
      });
    } catch (error) {
      console.error('Query data error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  /**
   * Get weather reports by specific date
   * Supports various date formats and precise date matching
   */
  async getByDate(req, res) {
    try {
      const { tableName } = req.params;
      const { date, timezone, includeTime } = req.query;
      
      // Get additional filters from request body (for POST requests)
      const bodyFilters = req.body?.filters || {};
      const options = req.body?.options || {};

      if (!date) {
        return res.status(400).json({
          success: false,
          error: 'Date parameter is required',
          message: 'Please provide a date in YYYY-MM-DD format or ISO string'
        });
      }

      const result = await this.dataRouter.getBySpecificDate(tableName, {
        date,
        timezone: timezone || 'UTC',
        includeTime: includeTime === 'true',
        ...bodyFilters
      }, {
        limit: options.limit || 100,
        offset: options.offset || 0,
        orderBy: options.orderBy || 'created_at',
        orderDirection: options.orderDirection || 'DESC',
        ...options
      });

      res.json({
        success: true,
        data: result.data,
        meta: {
          count: result.data.length,
          date: date,
          timezone: timezone || 'UTC',
          source: result.source,
          queryTime: result.queryTime,
          totalAvailable: result.totalCount || result.data.length
        }
      });

    } catch (error) {
      console.error('Date query error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve data by date',
        message: error.message
      });
    }
  }

  /**
   * Get count of records across all storage tiers
   */
  async getCount(req, res) {
    try {
      const { tableName } = req.params;
      const { startDate, endDate } = req.query;

      const filters = {
        startDate: startDate || null,
        endDate: endDate || null
      };

      // Add custom filters if provided
      if (req.body && req.body.customFilters) {
        filters.customWhere = req.body.customFilters.where;
        filters.customParams = req.body.customFilters.params;
      }

      const result = await this.dataRouter.getCount(tableName, filters);

      res.json({
        success: true,
        ...result,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Get count error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  /**
   * Get performance statistics for a table
   */
  async getPerformanceStats(req, res) {
    try {
      const { tableName } = req.params;
      const stats = await this.dataRouter.getPerformanceStats(tableName);

      res.json({
        success: true,
        stats,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Performance stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  /**
   * Clear cache for a specific table
   */
  async clearCache(req, res) {
    try {
      const { tableName } = req.params;
      await this.dataRouter.clearTableCache(tableName);

      res.json({
        success: true,
        message: `Cache cleared for table: ${tableName}`,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Clear cache error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  /**
   * Health check endpoint
   */
  async healthCheck(req, res) {
    try {
      // Basic health check - you can expand this
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        environment: process.env.NODE_ENV || 'development'
      };

      res.json(health);
    } catch (error) {
      console.error('Health check error:', error);
      res.status(500).json({
        status: 'unhealthy',
        error: error.message
      });
    }
  }

  /**
   * Advanced search with multiple filters
   */
  async advancedSearch(req, res) {
    try {
      const validation = this.validateAdvancedSearchParams(req.body);
      if (validation.error) {
        return res.status(400).json({
          success: false,
          error: 'Invalid search parameters',
          details: validation.error.details
        });
      }

      const { tableName } = req.params;
      const { 
        dateRange, 
        filters, 
        sorting, 
        pagination, 
        useCache = true 
      } = req.body;

      const queryFilters = {
        startDate: dateRange?.startDate || null,
        endDate: dateRange?.endDate || null
      };

      // Add custom filters
      if (filters && filters.length > 0) {
        const whereConditions = [];
        const params = [];

        filters.forEach(filter => {
          switch (filter.operator) {
            case 'equals':
              whereConditions.push(`${filter.field} = ?`);
              params.push(filter.value);
              break;
            case 'like':
              whereConditions.push(`${filter.field} LIKE ?`);
              params.push(`%${filter.value}%`);
              break;
            case 'in':
              const placeholders = filter.value.map(() => '?').join(',');
              whereConditions.push(`${filter.field} IN (${placeholders})`);
              params.push(...filter.value);
              break;
            case 'between':
              whereConditions.push(`${filter.field} BETWEEN ? AND ?`);
              params.push(filter.value.start, filter.value.end);
              break;
          }
        });

        if (whereConditions.length > 0) {
          queryFilters.customWhere = whereConditions.join(' AND ');
          queryFilters.customParams = params;
        }
      }

      const options = {
        limit: pagination?.limit || null,
        offset: pagination?.offset || null,
        orderBy: sorting?.field || 'created_at',
        orderDirection: sorting?.direction || 'DESC',
        useCache
      };

      const startTime = Date.now();
      const result = await this.dataRouter.query(tableName, queryFilters, options);
      const queryTime = Date.now() - startTime;

      res.json({
        success: true,
        ...result,
        meta: {
          queryTime: `${queryTime}ms`,
          timestamp: new Date().toISOString(),
          pagination: {
            ...pagination,
            hasMore: result.data.length === (pagination?.limit || 0)
          }
        }
      });
    } catch (error) {
      console.error('Advanced search error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  /**
   * Validate query parameters
   */
  validateQueryParams(queryParams) {
    const schema = Joi.object({
      startDate: Joi.date().iso().optional(),
      endDate: Joi.date().iso().optional(),
      limit: Joi.number().integer().min(1).max(10000).optional(),
      offset: Joi.number().integer().min(0).optional(),
      orderBy: Joi.string().max(100).optional(),
      orderDirection: Joi.string().valid('ASC', 'DESC').optional(),
      useCache: Joi.string().valid('true', 'false').optional()
    });

    return schema.validate(queryParams);
  }

  /**
   * Validate advanced search parameters
   */
  validateAdvancedSearchParams(body) {
    const schema = Joi.object({
      dateRange: Joi.object({
        startDate: Joi.date().iso().optional(),
        endDate: Joi.date().iso().optional()
      }).optional(),
      filters: Joi.array().items(
        Joi.object({
          field: Joi.string().required(),
          operator: Joi.string().valid('equals', 'like', 'in', 'between').required(),
          value: Joi.alternatives().try(
            Joi.string(),
            Joi.number(),
            Joi.array(),
            Joi.object({
              start: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
              end: Joi.alternatives().try(Joi.string(), Joi.number()).required()
            })
          ).required()
        })
      ).optional(),
      sorting: Joi.object({
        field: Joi.string().required(),
        direction: Joi.string().valid('ASC', 'DESC').optional()
      }).optional(),
      pagination: Joi.object({
        limit: Joi.number().integer().min(1).max(10000).optional(),
        offset: Joi.number().integer().min(0).optional()
      }).optional(),
      useCache: Joi.boolean().optional()
    });

    return schema.validate(body);
  }
}

module.exports = DataController;

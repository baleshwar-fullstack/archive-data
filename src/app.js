const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const winston = require('winston');
require('dotenv').config();

// Import routes
const dataRoutes = require('./routes/dataRoutes');
const scheduledMigrationRoutes = require('./routes/scheduledMigrationRoutes');

// Import configurations
// Redis removed - not needed for current implementation

class Application {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.setupLogging();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  /**
   * Setup Winston logging
   */
  setupLogging() {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'tiered-data-storage' },
      transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });

    // Create logs directory if it doesn't exist
    const fs = require('fs');
    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs');
    }
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // Security middleware
    this.app.use(helmet());
    
    // CORS configuration
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true
    }));

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      this.logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
      });
      next();
    });

    // Request timing
    this.app.use((req, res, next) => {
      req.startTime = Date.now();
      next();
    });

    // Response timing middleware
    this.app.use((req, res, next) => {
      const originalSend = res.send;
      
      res.send = function(data) {
        const responseTime = Date.now() - req.startTime;
        res.set('X-Response-Time', `${responseTime}ms`);
        originalSend.call(this, data);
      };
      
      next();
    });
  }

  /**
   * Setup application routes
   */
  setupRoutes() {
    // API routes
    this.app.use('/api/data', dataRoutes);
    this.app.use('/api/scheduled-migration', scheduledMigrationRoutes);

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Tiered Data Storage API',
        version: '1.0.0',
        description: 'Node.js API for querying data across MySQL and S3 Glacier storage tiers',
        endpoints: {
          // Data query endpoints
          health: '/api/data/health',
          query: '/api/data/:tableName',
          count: '/api/data/:tableName/count',
          stats: '/api/data/:tableName/stats',
          search: '/api/data/:tableName/search',
          cache: '/api/data/:tableName/cache',
          
          // Scheduled migration endpoints
          migrationHealth: '/api/scheduled-migration/health',
          migrationStatus: '/api/scheduled-migration/status',
          migrationInsights: '/api/scheduled-migration/insights',
          migrationConfig: '/api/scheduled-migration/config',
          migrationToggle: '/api/scheduled-migration/toggle',
          migrationTrigger: '/api/scheduled-migration/trigger',
          migrationLogs: '/api/scheduled-migration/logs'
        },
        timestamp: new Date().toISOString()
      });
    });

    // API documentation endpoint
    this.app.get('/api', (req, res) => {
      res.json({
        title: 'Tiered Data Storage API Documentation',
        version: '1.0.0',
        endpoints: [
          {
            method: 'GET',
            path: '/api/data/health',
            description: 'Health check endpoint'
          },
          {
            method: 'GET',
            path: '/api/data/:tableName',
            description: 'Query data from table',
            parameters: {
              query: ['startDate', 'endDate', 'limit', 'offset', 'orderBy', 'orderDirection', 'useCache']
            }
          },
          {
            method: 'POST',
            path: '/api/data/:tableName/query',
            description: 'Query data with custom filters',
            body: {
              customFilters: {
                where: 'string',
                params: 'array'
              }
            }
          },
          {
            method: 'POST',
            path: '/api/data/:tableName/search',
            description: 'Advanced search with complex filtering',
            body: {
              dateRange: { startDate: 'date', endDate: 'date' },
              filters: 'array',
              sorting: { field: 'string', direction: 'ASC|DESC' },
              pagination: { limit: 'number', offset: 'number' }
            }
          },
          {
            method: 'GET',
            path: '/api/data/:tableName/count',
            description: 'Get record count for table'
          },
          {
            method: 'GET',
            path: '/api/data/:tableName/stats',
            description: 'Get performance statistics for table'
          },
          {
            method: 'DELETE',
            path: '/api/data/:tableName/cache',
            description: 'Clear cache for table'
          }
        ],
        scheduledMigration: [
          {
            method: 'GET',
            path: '/api/scheduled-migration/health',
            description: 'Health check for scheduled migration service'
          },
          {
            method: 'GET',
            path: '/api/scheduled-migration/status',
            description: 'Get migration status and schedule information'
          },
          {
            method: 'GET',
            path: '/api/scheduled-migration/insights',
            description: 'Get migration insights and statistics'
          },
          {
            method: 'PUT',
            path: '/api/scheduled-migration/config',
            description: 'Update migration configuration'
          },
          {
            method: 'POST',
            path: '/api/scheduled-migration/toggle',
            description: 'Enable or disable scheduled migration'
          },
          {
            method: 'POST',
            path: '/api/scheduled-migration/trigger',
            description: 'Trigger migration manually'
          },
          {
            method: 'GET',
            path: '/api/scheduled-migration/logs',
            description: 'Get recent migration logs'
          }
        ]
      });
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.originalUrl,
        method: req.method
      });
    });
  }

  /**
   * Setup error handling middleware
   */
  setupErrorHandling() {
    // Global error handler
    this.app.use((error, req, res, next) => {
      this.logger.error('Unhandled error:', {
        error: error.message,
        stack: error.stack,
        path: req.path,
        method: req.method,
        ip: req.ip
      });

      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled Rejection:', { reason, promise });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
      process.exit(1);
    });
  }

  /**
   * Start the server
   */
  async start() {
    try {
      // Start the server (Redis removed - not needed)
      this.server = this.app.listen(this.port, () => {
        this.logger.info(`🚀 Tiered Data Storage API is running on port ${this.port}`);
        this.logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
        this.logger.info(`🔗 API Documentation: http://localhost:${this.port}/api`);
        this.logger.info(`❤️  Health Check: http://localhost:${this.port}/api/data/health`);
      });

      // Graceful shutdown handling
      this.setupGracefulShutdown();

    } catch (error) {
      this.logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  /**
   * Setup graceful shutdown
   */
  setupGracefulShutdown() {
    const gracefulShutdown = async (signal) => {
      this.logger.info(`Received ${signal}. Starting graceful shutdown...`);

      // Close server
      if (this.server) {
        this.server.close(() => {
          this.logger.info('HTTP server closed');
        });
      }

      // Close database connections would go here (Redis removed - not needed)
      // await database.close();

      this.logger.info('Graceful shutdown completed');
      process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  }

  /**
   * Get Express app instance
   */
  getApp() {
    return this.app;
  }
}

// Create and start the application
const application = new Application();

// Start server if this file is run directly
if (require.main === module) {
  application.start().catch(console.error);
}

module.exports = application;

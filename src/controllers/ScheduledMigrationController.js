const ScheduledMigrationService = require('../services/ScheduledMigrationService');
const Joi = require('joi');

class ScheduledMigrationController {
  constructor() {
    this.scheduler = new ScheduledMigrationService();
  }

  /**
   * Get migration status and schedule information
   */
  async getStatus(req, res) {
    try {
      const status = this.scheduler.getStatus();
      
      res.json({
        success: true,
        status,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Get migration status error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get migration status',
        message: error.message
      });
    }
  }

  /**
   * Update migration configuration
   */
  async updateConfig(req, res) {
    try {
      const validation = this.validateConfigUpdate(req.body);
      if (validation.error) {
        return res.status(400).json({
          success: false,
          error: 'Invalid configuration',
          details: validation.error.details
        });
      }

      const updatedConfig = this.scheduler.updateConfig(req.body);
      
      res.json({
        success: true,
        message: 'Configuration updated successfully',
        config: updatedConfig,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Update config error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update configuration',
        message: error.message
      });
    }
  }

  /**
   * Trigger migration manually (force run)
   */
  async triggerMigration(req, res) {
    try {
      // Check if migration is already running
      if (this.scheduler.isMigrationRunning()) {
        return res.status(409).json({
          success: false,
          error: 'Migration already running',
          lockInfo: this.scheduler.getLockInfo()
        });
      }

      // Start migration asynchronously
      const migrationPromise = this.scheduler.forceRunMigration();
      
      // Return immediately with job started response
      res.json({
        success: true,
        message: 'Migration triggered successfully',
        status: 'started',
        meta: {
          timestamp: new Date().toISOString(),
          note: 'Use GET /status to monitor progress'
        }
      });

      // Handle migration completion in background
      migrationPromise.then(result => {
        console.log('Manual migration completed:', result.success ? 'SUCCESS' : 'FAILED');
      }).catch(error => {
        console.error('Manual migration failed:', error.message);
      });

    } catch (error) {
      console.error('Trigger migration error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to trigger migration',
        message: error.message
      });
    }
  }

  /**
   * Get recent migration logs
   */
  async getLogs(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const logs = this.scheduler.getRecentLogs(limit);
      
      res.json({
        success: true,
        logs,
        meta: {
          count: logs.length,
          limit,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Get logs error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get migration logs',
        message: error.message
      });
    }
  }

  /**
   * Get specific log file content
   */
  async getLogContent(req, res) {
    try {
      const { filename } = req.params;
      const logs = this.scheduler.getRecentLogs(100); // Get more logs to find the requested one
      const logFile = logs.find(log => log.filename === filename);
      
      if (!logFile) {
        return res.status(404).json({
          success: false,
          error: 'Log file not found'
        });
      }

      const fs = require('fs');
      const logContent = fs.readFileSync(logFile.path, 'utf8');
      
      res.json({
        success: true,
        filename: logFile.filename,
        timestamp: logFile.timestamp,
        size: logFile.size,
        content: logContent,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Get log content error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get log content',
        message: error.message
      });
    }
  }

  /**
   * Enable or disable scheduled migration
   */
  async toggleSchedule(req, res) {
    try {
      const { enabled } = req.body;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'Invalid request',
          message: 'enabled field must be a boolean'
        });
      }

      const updatedConfig = this.scheduler.updateConfig({ enabled });
      
      res.json({
        success: true,
        message: `Scheduled migration ${enabled ? 'enabled' : 'disabled'}`,
        enabled: updatedConfig.enabled,
        nextRun: updatedConfig.nextRun,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Toggle schedule error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to toggle schedule',
        message: error.message
      });
    }
  }

  /**
   * Update schedule interval
   */
  async updateInterval(req, res) {
    try {
      const { intervalMonths } = req.body;
      
      if (!intervalMonths || !Number.isInteger(intervalMonths) || intervalMonths < 1) {
        return res.status(400).json({
          success: false,
          error: 'Invalid interval',
          message: 'intervalMonths must be a positive integer'
        });
      }

      const updatedConfig = this.scheduler.updateConfig({ scheduleIntervalMonths: intervalMonths });
      
      res.json({
        success: true,
        message: `Schedule interval updated to ${intervalMonths} months`,
        intervalMonths: updatedConfig.scheduleIntervalMonths,
        nextRun: updatedConfig.nextRun,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Update interval error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update interval',
        message: error.message
      });
    }
  }

  /**
   * Get migration statistics and insights
   */
  async getInsights(req, res) {
    try {
      const logs = this.scheduler.getRecentLogs(50);
      const status = this.scheduler.getStatus();
      
      // Parse log data for insights
      const insights = {
        totalMigrations: logs.length,
        averageFileSize: logs.length > 0 ? logs.reduce((sum, log) => sum + log.size, 0) / logs.length : 0,
        migrationHistory: logs.slice(0, 10).map(log => ({
          timestamp: log.timestamp,
          filename: log.filename,
          size: log.size
        })),
        nextMigration: {
          scheduled: status.schedule.nextRun,
          timeRemaining: status.schedule.timeUntilNextRun,
          shouldRun: status.schedule.shouldRun
        },
        configuration: {
          enabled: status.enabled,
          interval: status.schedule.intervalMonths,
          tables: status.tables,
          batchSize: status.configuration.batchSize
        }
      };
      
      res.json({
        success: true,
        insights,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Get insights error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get migration insights',
        message: error.message
      });
    }
  }

  /**
   * Health check for scheduled migration service
   */
  async healthCheck(req, res) {
    try {
      const status = this.scheduler.getStatus();
      const isHealthy = status.enabled && !status.isRunning; // Healthy if enabled and not stuck
      
      res.status(isHealthy ? 200 : 503).json({
        success: isHealthy,
        status: isHealthy ? 'healthy' : 'degraded',
        enabled: status.enabled,
        isRunning: status.isRunning,
        lastRun: status.schedule.lastRun,
        nextRun: status.schedule.nextRun,
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Health check error:', error);
      res.status(503).json({
        success: false,
        status: 'unhealthy',
        error: error.message
      });
    }
  }

  /**
   * Validate configuration update request
   */
  validateConfigUpdate(body) {
    const schema = Joi.object({
      enabled: Joi.boolean().optional(),
      scheduleIntervalMonths: Joi.number().integer().min(1).max(60).optional(),
      tables: Joi.array().items(Joi.string()).optional(),
      retryAttempts: Joi.number().integer().min(1).max(10).optional(),
      retryDelayMinutes: Joi.number().integer().min(1).max(1440).optional(),
      batchSize: Joi.number().integer().min(100).max(10000).optional(),
      notifications: Joi.object({
        email: Joi.object({
          enabled: Joi.boolean(),
          recipients: Joi.array().items(Joi.string().email()),
          smtp: Joi.object()
        }).optional(),
        webhook: Joi.object({
          enabled: Joi.boolean(),
          url: Joi.string().uri()
        }).optional()
      }).optional()
    });

    return schema.validate(body);
  }
}

module.exports = ScheduledMigrationController;

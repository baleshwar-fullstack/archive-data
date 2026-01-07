const DataMigrationService = require('../scripts/migrate-old-data');
const moment = require('moment');
const fs = require('fs');
const path = require('path');

class ScheduledMigrationService {
  constructor() {
    this.migrationService = new DataMigrationService();
    this.isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

    // Use appropriate directories based on environment
    if (this.isLambda) {
      this.logDir = '/tmp/logs/scheduled-migrations';
      this.configFile = '/tmp/config/migration-schedule.json';
      this.lockFile = '/tmp/migration.lock';
    } else {
      this.logDir = path.join(process.cwd(), 'logs', 'scheduled-migrations');
      this.configFile = path.join(process.cwd(), 'config', 'migration-schedule.json');
      this.lockFile = path.join(process.cwd(), 'tmp', 'migration.lock');
    }

    // Ensure directories exist
    this.ensureDirectories();

    // Load configuration
    this.config = this.loadConfig();
  }

  /**
   * Ensure required directories exist
   */
  ensureDirectories() {
    [this.logDir, path.dirname(this.configFile), path.dirname(this.lockFile)].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Load migration schedule configuration
   */
  loadConfig() {
    const defaultConfig = {
      enabled: true,
      scheduleIntervalMonths: 6,
      tables: ['weather_reports', 'project_hours'],
      retryAttempts: 3,
      retryDelayMinutes: 30,
      batchSize: 1000,
      notifications: {
        email: {
          enabled: false,
          recipients: [],
          smtp: {}
        },
        webhook: {
          enabled: false,
          url: null
        }
      },
      lastRun: null,
      nextRun: null
    };

    if (fs.existsSync(this.configFile)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        return { ...defaultConfig, ...fileConfig };
      } catch (error) {
        console.error('Error loading migration config, using defaults:', error);
        return defaultConfig;
      }
    } else {
      // Create default config file
      this.saveConfig(defaultConfig);
      return defaultConfig;
    }
  }

  /**
   * Save configuration to file
   */
  saveConfig(config) {
    try {
      fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error saving migration config:', error);
    }
  }

  /**
   * Check if migration should run now
   */
  shouldRunMigration() {
    if (!this.config.enabled) {
      return false;
    }

    const now = moment();

    // If no last run, schedule should run
    if (!this.config.lastRun) {
      return true;
    }

    const lastRun = moment(this.config.lastRun);
    const monthsSinceLastRun = now.diff(lastRun, 'months');

    return monthsSinceLastRun >= this.config.scheduleIntervalMonths;
  }

  /**
   * Calculate next run time
   */
  calculateNextRun() {
    const now = moment();
    if (this.config.lastRun) {
      return moment(this.config.lastRun).add(this.config.scheduleIntervalMonths, 'months');
    } else {
      return now.add(this.config.scheduleIntervalMonths, 'months');
    }
  }

  /**
   * Check if migration is currently running (lock file exists)
   */
  isMigrationRunning() {
    return fs.existsSync(this.lockFile);
  }

  /**
   * Create migration lock file
   */
  createLock() {
    const lockData = {
      pid: process.pid,
      startTime: new Date().toISOString(),
      tables: this.config.tables
    };
    fs.writeFileSync(this.lockFile, JSON.stringify(lockData, null, 2));
  }

  /**
   * Remove migration lock file
   */
  removeLock() {
    if (fs.existsSync(this.lockFile)) {
      fs.unlinkSync(this.lockFile);
    }
  }

  /**
   * Get migration lock information
   */
  getLockInfo() {
    if (!fs.existsSync(this.lockFile)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
    } catch (error) {
      console.error('Error reading lock file:', error);
      return null;
    }
  }

  /**
   * Main scheduled migration execution
   */
  async runScheduledMigration() {
    const startTime = new Date();
    const logFile = path.join(this.logDir, `migration-${moment().format('YYYY-MM-DD-HH-mm-ss')}.log`);

    // Create log stream
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const log = (message) => {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] ${message}\n`;
      console.log(message);
      logStream.write(logMessage);
    };

    try {
      log('Starting scheduled migration check...');

      // Check if migration should run
      if (!this.shouldRunMigration()) {
        const nextRun = this.calculateNextRun();
        log(`Migration not due yet. Next run scheduled for: ${nextRun.format('YYYY-MM-DD HH:mm:ss')}`);
        logStream.end();
        return { success: true, skipped: true, nextRun: nextRun.toISOString() };
      }

      // Check if migration is already running
      if (this.isMigrationRunning()) {
        const lockInfo = this.getLockInfo();
        log(`Migration already running (PID: ${lockInfo?.pid}, Started: ${lockInfo?.startTime})`);
        logStream.end();
        return { success: false, error: 'Migration already running', lockInfo };
      }

      log('Starting scheduled migration...');

      // Create lock
      this.createLock();

      const migrationResults = {};
      let totalSuccess = true;

      // Migrate each configured table
      for (const tableName of this.config.tables) {
        log(`\nMigrating table: ${tableName}`);

        let attempts = 0;
        let tableSuccess = false;

        while (attempts < this.config.retryAttempts && !tableSuccess) {
          attempts++;

          try {
            log(`Attempt ${attempts}/${this.config.retryAttempts} for ${tableName}`);

            // Set batch size from config
            process.env.MIGRATION_BATCH_SIZE = this.config.batchSize.toString();

            const result = await this.migrationService.migrate(tableName, { dryRun: false });

            migrationResults[tableName] = {
              success: true,
              attempts,
              ...result
            };

            log(`${tableName} migration completed successfully`);
            log(`- Processed: ${result.totalProcessed}`);
            log(`- Archived: ${result.totalArchived}`);
            log(`- Deleted: ${result.totalDeleted}`);
            log(`- Errors: ${result.errors}`);

            tableSuccess = true;

          } catch (error) {
            log(`Attempt ${attempts} failed for ${tableName}: ${error.message}`);

            if (attempts < this.config.retryAttempts) {
              log(`Waiting ${this.config.retryDelayMinutes} minutes before retry...`);
              await this.sleep(this.config.retryDelayMinutes * 60 * 1000);
            } else {
              migrationResults[tableName] = {
                success: false,
                attempts,
                error: error.message
              };
              totalSuccess = false;
              log(`All attempts failed for ${tableName}`);
            }
          }
        }
      }

      // Update configuration
      const endTime = new Date();
      this.config.lastRun = startTime.toISOString();
      this.config.nextRun = this.calculateNextRun().toISOString();
      this.saveConfig(this.config);

      const duration = Math.round((endTime - startTime) / 1000);
      log(`\nScheduled migration completed in ${duration} seconds`);
      log(`Next migration scheduled for: ${this.config.nextRun}`);

      // Notifications disabled - removed to reduce complexity

      // Remove lock
      this.removeLock();
      logStream.end();

      return {
        success: totalSuccess,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
        results: migrationResults,
        nextRun: this.config.nextRun,
        logFile
      };

    } catch (error) {
      log(`Scheduled migration failed: ${error.message}`);
      log(`Stack trace: ${error.stack}`);

      // Remove lock on error
      this.removeLock();
      logStream.end();

      throw error;
    }
  }


  /**
   * Get migration status and schedule information
   */
  getStatus() {
    const now = moment();
    const isRunning = this.isMigrationRunning();
    const lockInfo = isRunning ? this.getLockInfo() : null;

    const status = {
      enabled: this.config.enabled,
      isRunning,
      lockInfo,
      schedule: {
        intervalMonths: this.config.scheduleIntervalMonths,
        lastRun: this.config.lastRun,
        nextRun: this.config.nextRun,
        shouldRun: this.shouldRunMigration()
      },
      tables: this.config.tables,
      configuration: {
        batchSize: this.config.batchSize,
        retryAttempts: this.config.retryAttempts,
        retryDelayMinutes: this.config.retryDelayMinutes
      }
    };

    if (this.config.nextRun) {
      const nextRun = moment(this.config.nextRun);
      status.schedule.timeUntilNextRun = nextRun.diff(now, 'hours') + ' hours';
    }

    return status;
  }

  /**
   * Update migration schedule configuration
   */
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };

    // Recalculate next run if interval changed
    if (updates.scheduleIntervalMonths) {
      this.config.nextRun = this.calculateNextRun().toISOString();
    }

    this.saveConfig(this.config);
    return this.config;
  }

  /**
   * Force run migration (ignore schedule)
   */
  async forceRunMigration() {
    console.log('🔧 Force running migration (ignoring schedule)...');

    // Temporarily disable schedule check
    const originalEnabled = this.config.enabled;
    this.config.enabled = true;

    // Force last run to be old enough
    const originalLastRun = this.config.lastRun;
    this.config.lastRun = moment().subtract(this.config.scheduleIntervalMonths + 1, 'months').toISOString();

    try {
      const result = await this.runScheduledMigration();
      return result;
    } finally {
      // Restore original config
      this.config.enabled = originalEnabled;
      if (!result?.success) {
        this.config.lastRun = originalLastRun;
        this.saveConfig(this.config);
      }
    }
  }

  /**
   * Get recent migration logs
   */
  getRecentLogs(limit = 10) {
    try {
      if (!fs.existsSync(this.logDir)) {
        return [];
      }

      const logFiles = fs.readdirSync(this.logDir)
        .filter(file => file.startsWith('migration-') && file.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, limit);

      return logFiles.map(file => ({
        filename: file,
        path: path.join(this.logDir, file),
        timestamp: file.match(/migration-(.+)\.log/)?.[1],
        size: fs.statSync(path.join(this.logDir, file)).size
      }));
    } catch (error) {
      console.error('Error getting recent logs:', error);
      return [];
    }
  }

  /**
   * Run migration for a specific table
   */
  async runTableMigration(tableName) {
    const startTime = moment();
    const logFile = path.join(this.logDir, `migration-${tableName}-${startTime.format('YYYY-MM-DD-HH-mm-ss')}.log`);
    const logStream = fs.createWriteStream(logFile);

    const log = (message) => {
      const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
      const logMessage = `[${timestamp}] ${message}\n`;
      console.log(message);
      logStream.write(logMessage);
    };

    try {
      log(`Starting migration for table: ${tableName}`);

      // Check if table is supported
      if (!this.config.tables.includes(tableName)) {
        throw new Error(`Table ${tableName} is not configured for migration`);
      }

      // Set batch size from config
      process.env.MIGRATION_BATCH_SIZE = this.config.batchSize.toString();

      let attempts = 0;
      let success = false;
      let result = null;

      while (attempts < this.config.retryAttempts && !success) {
        attempts++;

        try {
          log(`Attempt ${attempts}/${this.config.retryAttempts} for ${tableName}`);

          result = await this.migrationService.migrate(tableName, { dryRun: false });

          log(`${tableName} migration completed successfully`);
          log(`- Processed: ${result.totalProcessed}`);
          log(`- Archived: ${result.totalArchived}`);
          log(`- Deleted: ${result.totalDeleted}`);
          log(`- Errors: ${result.errors}`);

          success = true;

        } catch (error) {
          log(`Attempt ${attempts} failed for ${tableName}: ${error.message}`);

          if (attempts < this.config.retryAttempts) {
            log(`Waiting ${this.config.retryDelayMinutes} minutes before retry...`);
            await this.sleep(this.config.retryDelayMinutes * 60 * 1000);
          } else {
            log(`All attempts failed for ${tableName}`);
            throw error;
          }
        }
      }

      const endTime = moment();
      const duration = Math.round((endTime - startTime) / 1000);

      log(`Migration completed for ${tableName} in ${duration} seconds`);
      logStream.end();

      return {
        success: true,
        tableName,
        duration,
        attempts,
        result,
        logFile
      };

    } catch (error) {
      log(`Migration failed for ${tableName}: ${error.message}`);
      log(`Stack trace: ${error.stack}`);
      logStream.end();

      return {
        success: false,
        tableName,
        error: error.message,
        stack: error.stack,
        logFile
      };
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ScheduledMigrationService;

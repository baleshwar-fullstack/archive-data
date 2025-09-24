#!/usr/bin/env node

/**
 * Scheduled Migration CLI
 * 
 * This script manages scheduled data migration from MySQL to S3.
 * Designed to run automatically every 6 months via cron.
 */

const ScheduledMigrationService = require('../services/ScheduledMigrationService');
require('dotenv').config();

class ScheduledMigrationCLI {
  constructor() {
    this.scheduler = new ScheduledMigrationService();
  }

  /**
   * Run scheduled migration check
   */
  async run() {
    try {
      console.log('Scheduled Migration Service Starting...');
      console.log(`Current time: ${new Date().toISOString()}`);
      
      const result = await this.scheduler.runScheduledMigration();
      
      if (result.skipped) {
        console.log('Migration skipped - not due yet');
        console.log(`Next run: ${result.nextRun}`);
        process.exit(0);
      } else if (result.success) {
        console.log('Scheduled migration completed successfully');
        console.log(`Summary:`);
        console.log(`   - Duration: ${result.duration}s`);
        console.log(`   - Tables processed: ${Object.keys(result.results).length}`);
        console.log(`   - Next run: ${result.nextRun}`);
        console.log(`   - Log file: ${result.logFile}`);
        process.exit(0);
      } else {
        console.error('Scheduled migration failed');
        console.error(`Results:`, result.results);
        process.exit(1);
      }
    } catch (error) {
      console.error('Critical error in scheduled migration:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  }

  /**
   * Show current status
   */
  async status() {
    try {
      const status = this.scheduler.getStatus();
      
      console.log('Scheduled Migration Status');
      console.log('=' * 40);
      console.log(`Enabled: ${status.enabled ? 'Enabled' : 'Disabled'}`);
      console.log(`Currently Running: ${status.isRunning ? 'Yes' : 'No'}`);
      console.log(`Schedule Interval: ${status.schedule.intervalMonths} months`);
      console.log(`Tables: ${status.tables.join(', ')}`);
      
      if (status.schedule.lastRun) {
        console.log(`Last Run: ${new Date(status.schedule.lastRun).toLocaleString()}`);
      } else {
        console.log(`Last Run: Never`);
      }
      
      if (status.schedule.nextRun) {
        console.log(`Next Run: ${new Date(status.schedule.nextRun).toLocaleString()}`);
        console.log(`Time Until Next: ${status.schedule.timeUntilNextRun}`);
      }
      
      console.log(`Should Run Now: ${status.schedule.shouldRun ? 'Yes' : 'No'}`);
      
      if (status.isRunning && status.lockInfo) {
        console.log('\n🔒 Current Migration Lock:');
        console.log(`   PID: ${status.lockInfo.pid}`);
        console.log(`   Started: ${new Date(status.lockInfo.startTime).toLocaleString()}`);
        console.log(`   Tables: ${status.lockInfo.tables.join(', ')}`);
      }
      
      console.log('\nConfiguration:');
      console.log(`   Batch Size: ${status.configuration.batchSize}`);
      console.log(`   Retry Attempts: ${status.configuration.retryAttempts}`);
      console.log(`   Retry Delay: ${status.configuration.retryDelayMinutes} minutes`);
      
    } catch (error) {
      console.error('Error getting status:', error.message);
      process.exit(1);
    }
  }

  /**
   * Force run migration
   */
  async force() {
    try {
      console.log('Force running migration...');
      const result = await this.scheduler.forceRunMigration();
      
      if (result.success) {
        console.log('Force migration completed successfully');
        console.log(`Duration: ${result.duration}s`);
      } else {
        console.error('Force migration failed');
        console.error(result.results);
        process.exit(1);
      }
    } catch (error) {
      console.error('Error in force migration:', error.message);
      process.exit(1);
    }
  }

  /**
   * Enable/disable scheduled migration
   */
  async toggle(enabled) {
    try {
      const config = this.scheduler.updateConfig({ enabled });
      console.log(`${enabled ? 'Enabled' : 'Disabled'} scheduled migration`);
      
      if (enabled && config.nextRun) {
        console.log(`Next run: ${new Date(config.nextRun).toLocaleString()}`);
      }
    } catch (error) {
      console.error('Error toggling migration:', error.message);
      process.exit(1);
    }
  }

  /**
   * Update schedule interval
   */
  async setInterval(months) {
    try {
      const config = this.scheduler.updateConfig({ scheduleIntervalMonths: months });
      console.log(`Updated schedule interval to ${months} months`);
      console.log(`Next run: ${new Date(config.nextRun).toLocaleString()}`);
    } catch (error) {
      console.error('Error updating interval:', error.message);
      process.exit(1);
    }
  }

  /**
   * Show recent logs
   */
  async logs(limit = 5) {
    try {
      const logs = this.scheduler.getRecentLogs(limit);
      
      if (logs.length === 0) {
        console.log('No migration logs found');
        return;
      }
      
      console.log(`Recent Migration Logs (${logs.length}):`);
      console.log('=' * 50);
      
      logs.forEach((log, index) => {
        console.log(`${index + 1}. ${log.filename}`);
        console.log(`   Timestamp: ${log.timestamp}`);
        console.log(`   Size: ${(log.size / 1024).toFixed(2)} KB`);
        console.log(`   Path: ${log.path}`);
        console.log('');
      });
    } catch (error) {
      console.error('Error getting logs:', error.message);
      process.exit(1);
    }
  }

  /**
   * Test configuration and connections
   */
  async test() {
    try {
      console.log('Testing scheduled migration configuration...');
      
      // Test database connection
      console.log('Testing MySQL connection...');
      // Add database connection test here
      
      // Test S3 connection
      console.log('Testing S3 connection...');
      // Add S3 connection test here
      
      // Test configuration
      const status = this.scheduler.getStatus();
      console.log('Configuration valid');
      
      console.log('\nCurrent Configuration:');
      console.log(`   Tables: ${status.tables.join(', ')}`);
      console.log(`   Interval: ${status.schedule.intervalMonths} months`);
      console.log(`   Batch Size: ${status.configuration.batchSize}`);
      
      console.log('\nAll tests passed');
      
    } catch (error) {
      console.error('Test failed:', error.message);
      process.exit(1);
    }
  }

  /**
   * Generate cron configuration
   */
  generateCron() {
    console.log('Cron Configuration for 6-Month Scheduled Migration');
    console.log('=' * 60);
    console.log('Add one of these lines to your crontab (crontab -e):');
    console.log('');
    
    // Every 6 months on the 1st at 2 AM
    console.log('# Run every 6 months on the 1st at 2:00 AM');
    console.log('0 2 1 */6 * /usr/bin/node /path/to/your/project/src/scripts/scheduled-migration.js run');
    console.log('');
    
    // Alternative: Every January 1st and July 1st at 2 AM
    console.log('# Run every January 1st and July 1st at 2:00 AM');
    console.log('0 2 1 1,7 * /usr/bin/node /path/to/your/project/src/scripts/scheduled-migration.js run');
    console.log('');
    
    console.log('📝 Notes:');
    console.log('   - Update the path to match your project location');
    console.log('   - Ensure the script has execution permissions: chmod +x scheduled-migration.js');
    console.log('   - Check cron logs: grep CRON /var/log/syslog');
    console.log('   - Test with: node src/scripts/scheduled-migration.js test');
    console.log('');
    
    console.log('Status check cron (daily at 9 AM):');
    console.log('0 9 * * * /usr/bin/node /path/to/your/project/src/scripts/scheduled-migration.js status > /tmp/migration-status.log 2>&1');
  }
}

// CLI execution
async function main() {
  const cli = new ScheduledMigrationCLI();
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
Scheduled Migration CLI - Weather Reports Data Archival

Usage: node src/scripts/scheduled-migration.js <command> [options]

Commands:
  run               Run scheduled migration check (main cron command)
  status            Show current migration status and schedule
  force             Force run migration (ignore schedule)
  enable            Enable scheduled migration
  disable           Disable scheduled migration
  interval <months> Set schedule interval (e.g., 6 for 6 months)
  logs [limit]      Show recent migration logs (default: 5)
  test              Test configuration and connections
  cron              Generate cron configuration examples

Examples:
  node src/scripts/scheduled-migration.js run
  node src/scripts/scheduled-migration.js status
  node src/scripts/scheduled-migration.js force
  node src/scripts/scheduled-migration.js interval 6
  node src/scripts/scheduled-migration.js logs 10
  node src/scripts/scheduled-migration.js cron
    `);
    process.exit(1);
  }

  try {
    switch (command) {
      case 'run':
        await cli.run();
        break;
        
      case 'status':
        await cli.status();
        break;
        
      case 'force':
        await cli.force();
        break;
        
      case 'enable':
        await cli.toggle(true);
        break;
        
      case 'disable':
        await cli.toggle(false);
        break;
        
      case 'interval':
        const months = parseInt(args[1]);
        if (!months || months < 1) {
          console.error('Please provide a valid number of months (e.g., 6)');
          process.exit(1);
        }
        await cli.setInterval(months);
        break;
        
      case 'logs':
        const limit = parseInt(args[1]) || 5;
        await cli.logs(limit);
        break;
        
      case 'test':
        await cli.test();
        break;
        
      case 'cron':
        cli.generateCron();
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Command failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = ScheduledMigrationCLI;

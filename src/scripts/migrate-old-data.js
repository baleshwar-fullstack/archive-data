#!/usr/bin/env node

const MySQLService = require('../services/MySQLService');
const S3ArchiveService = require('../services/S3ArchiveService');
require('dotenv').config();

class DataMigrationService {
  constructor() {
    this.mysqlService = new MySQLService();
    this.s3ArchiveService = new S3ArchiveService();
    this.batchSize = parseInt(process.env.MIGRATION_BATCH_SIZE) || 1000;
    this.maxRetries = 3;
    this.retryDelay = 5000; // 5 seconds
  }

  /**
   * Main migration function
   */
  async migrate(tableName, options = {}) {
    console.log(`\n🚀 Starting migration for table: ${tableName}`);
    console.log(`📊 Batch size: ${this.batchSize}`);
    
    const stats = {
      totalProcessed: 0,
      totalArchived: 0,
      totalDeleted: 0,
      errors: 0,
      startTime: Date.now()
    };

    try {
      // Get initial count of records to migrate
      const totalRecords = await this.getTotalRecordsToMigrate(tableName);
      console.log(`📋 Total records to migrate: ${totalRecords}`);

      if (totalRecords === 0) {
        console.log('No records to migrate.');
        return stats;
      }

      let offset = 0;
      let hasMoreData = true;

      while (hasMoreData) {
        console.log(`\n📦 Processing batch ${Math.floor(offset / this.batchSize) + 1}...`);
        
        const batchResult = await this.processBatch(tableName, offset, options);
        
        stats.totalProcessed += batchResult.processed;
        stats.totalArchived += batchResult.archived;
        stats.totalDeleted += batchResult.deleted;
        stats.errors += batchResult.errors;

        // Progress reporting
        const progressPercent = ((stats.totalProcessed / totalRecords) * 100).toFixed(1);
        console.log(`📈 Progress: ${stats.totalProcessed}/${totalRecords} (${progressPercent}%)`);

        if (batchResult.processed < this.batchSize) {
          hasMoreData = false;
        } else {
          offset += this.batchSize;
        }

        // Small delay between batches to prevent overwhelming the system
        await this.sleep(1000);
      }

      const duration = (Date.now() - stats.startTime) / 1000;
      console.log(`\nMigration completed for ${tableName}`);
      console.log(`📊 Final Stats:`);
      console.log(`   - Total Processed: ${stats.totalProcessed}`);
      console.log(`   - Total Archived: ${stats.totalArchived}`);
      console.log(`   - Total Deleted: ${stats.totalDeleted}`);
      console.log(`   - Errors: ${stats.errors}`);
      console.log(`   - Duration: ${duration}s`);

      return stats;
    } catch (error) {
      console.error(`Migration failed for ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Process a single batch of records
   */
  async processBatch(tableName, offset, options) {
    const batchStats = {
      processed: 0,
      archived: 0,
      deleted: 0,
      errors: 0
    };

    try {
      // Get records for this batch
      const records = await this.mysqlService.getRecordsForArchive(tableName, this.batchSize, offset);
      
      if (!records || records.length === 0) {
        return batchStats;
      }

      batchStats.processed = records.length;

      // Group records by year for efficient S3 partitioning
      const recordGroups = this.groupRecordsByYear(records);

      // Archive each group
      for (const [year, groupRecords] of Object.entries(recordGroups)) {
        let retryCount = 0;
        let archived = false;

        while (retryCount < this.maxRetries && !archived) {
          try {
            const archiveResult = await this.s3ArchiveService.archiveData(
              tableName, 
              groupRecords, 
              parseInt(year) // Auto-detection will be used if not provided
            );

            if (archiveResult.success) {
              batchStats.archived += archiveResult.archivedCount;
              
              // Delete from MySQL only after successful archive
              if (!options.dryRun) {
                const recordIds = groupRecords.map(r => r.id);
                const deleteResult = await this.mysqlService.deleteArchivedRecords(tableName, recordIds);
                batchStats.deleted += deleteResult.deletedCount;
              }
              
              console.log(`   Archived ${groupRecords.length} records for year ${year} (${archiveResult.partitionStrategy})`);
              archived = true;
            }
          } catch (error) {
            retryCount++;
            console.error(`   Archive attempt ${retryCount} failed for year ${year}:`, error.message);
            
            if (retryCount < this.maxRetries) {
              console.log(`   🔄 Retrying in ${this.retryDelay / 1000}s...`);
              await this.sleep(this.retryDelay);
            } else {
              console.error(`   Max retries exceeded for year ${year}`);
              batchStats.errors += groupRecords.length;
            }
          }
        }
      }

      return batchStats;
    } catch (error) {
      console.error(`Batch processing error:`, error);
      batchStats.errors += batchStats.processed;
      return batchStats;
    }
  }

  /**
   * Group records by year for automatic partitioning
   */
  groupRecordsByYear(records) {
    const groups = {};

    records.forEach(record => {
      const created = String(record.created_at || '');
      const year = created.slice(0, 4); // Preserve exactly as stored (no parsing)

      if (!groups[year]) {
        groups[year] = [];
      }

      groups[year].push(record);
    });

    return groups;
  }

  /**
   * Get total count of records that need migration
   */
  async getTotalRecordsToMigrate(tableName) {
    try {
      const cutoffDate = this.mysqlService.getArchiveCutoffDate();
      const query = `SELECT COUNT(*) as count FROM ${tableName} WHERE created_at < ?`;
      const result = await this.mysqlService.db.query(query, [cutoffDate]);
      return result[0].count;
    } catch (error) {
      console.error('Error getting migration count:', error);
      throw error;
    }
  }

  /**
   * Verify migration integrity
   */
  async verifyMigration(tableName) {
    console.log(`\n🔍 Verifying migration for ${tableName}...`);

    try {
      // Check if any old records remain in MySQL
      const remainingCount = await this.getTotalRecordsToMigrate(tableName);
      
      if (remainingCount > 0) {
        console.log(`⚠️  Warning: ${remainingCount} old records still remain in MySQL`);
        return false;
      }

      // Get archived record count from S3
      const archivedCount = await this.s3ArchiveService.getArchivedCount(tableName);
      
      console.log(`Verification completed:`);
      console.log(`   - Records remaining in MySQL: ${remainingCount}`);
      console.log(`   - Records archived in S3: ${archivedCount}`);

      return remainingCount === 0;
    } catch (error) {
      console.error('Verification failed:', error);
      return false;
    }
  }

  /**
   * Rollback migration (restore from S3 to MySQL)
   */
  async rollback(tableName, options = {}) {
    console.log(`\n🔄 Starting rollback for table: ${tableName}`);
    
    try {
      // This is a simplified rollback implementation
      // In production, you'd want more sophisticated rollback logic
      console.log('⚠️  Rollback functionality requires careful implementation');
      console.log('   Consider implementing based on your specific requirements');
      
      if (options.confirm !== true) {
        console.log('Rollback cancelled. Use { confirm: true } to proceed.');
        return false;
      }

      // Implementation would involve:
      // 1. Querying archived data from S3
      // 2. Restoring to MySQL
      // 3. Deleting from S3 if successful
      
      console.log('🚧 Rollback functionality not implemented in this example');
      return false;
    } catch (error) {
      console.error('Rollback failed:', error);
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

// CLI execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Usage: node migrate-old-data.js <command> [options]

Commands:
  migrate <table_name>     Migrate old data from MySQL to S3
  verify <table_name>      Verify migration integrity
  rollback <table_name>    Rollback migration (restore from S3)

Options:
  --dry-run               Show what would be migrated without actually doing it
  --batch-size <size>     Set batch size (default: 1000)

Examples:
  node migrate-old-data.js migrate users
  node migrate-old-data.js migrate orders --dry-run
  node migrate-old-data.js verify users
    `);
    process.exit(1);
  }

  const command = args[0];
  const tableName = args[1];
  const isDryRun = args.includes('--dry-run');
  
  const batchSizeIndex = args.indexOf('--batch-size');
  const batchSize = batchSizeIndex !== -1 ? parseInt(args[batchSizeIndex + 1]) : 1000;

  if (batchSize) {
    process.env.MIGRATION_BATCH_SIZE = batchSize.toString();
  }

  const migrationService = new DataMigrationService();

  try {
    switch (command) {
      case 'migrate':
        if (!tableName) {
          console.error('Table name is required for migration');
          process.exit(1);
        }
        await migrationService.migrate(tableName, { dryRun: isDryRun });
        break;

      case 'verify':
        if (!tableName) {
          console.error('Table name is required for verification');
          process.exit(1);
        }
        const isValid = await migrationService.verifyMigration(tableName);
        process.exit(isValid ? 0 : 1);
        break;

      case 'rollback':
        if (!tableName) {
          console.error('Table name is required for rollback');
          process.exit(1);
        }
        await migrationService.rollback(tableName, { confirm: true });
        break;

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }

    console.log('\nOperation completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\nOperation failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = DataMigrationService;

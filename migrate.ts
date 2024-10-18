#!/usr/bin/env bun

/**
 * Simple declarative schema migration for SQLite.
 * 
 * Create a declarative schema like this:
 * 
 * schema.sql
 * ```
 * -- Users table
 * CREATE TABLE users (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     username TEXT NOT NULL UNIQUE,
 *     email TEXT NOT NULL UNIQUE,
 *     password_hash TEXT NOT NULL,
 *     is_admin BOOLEAN NOT NULL DEFAULT FALSE,
 *     characters_remaining INTEGER NOT NULL DEFAULT 1000000,
 *     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 * );
 * 
 * -- Sessions table
 * CREATE TABLE sessions (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     user_id INTEGER NOT NULL,
 *     token TEXT NOT NULL UNIQUE,
 *     expires_at TIMESTAMP NOT NULL,
 *     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
 * );
 * 
 * -- Index for faster token lookups
 * CREATE INDEX idx_sessions_token ON sessions(token);
 * 
 * -- Index for user lookups in sessions
 * CREATE INDEX idx_sessions_user_id ON sessions(user_id);
 * 
 * -- Trigger to update the updated_at timestamp for users
 * CREATE TRIGGER update_users_timestamp 
 * AFTER UPDATE ON users
 * BEGIN
 *     UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
 * END;
 * ```
 * 
 * Then run this script:
 * 
 * ```
 * bun migrator.ts db.sqlite schema.sql
 * ```
 * 
 * Change the schema.sql file and re-run the script to migrate again.
 * 
 * See <https://david.rothlis.net/declarative-schema-migration-for-sqlite>
 * for the original motivation.
 * 
 * Original Author: William Manley <will@stb-tester.com>.
 * Copyright © 2019-2022 Stb-tester.com Ltd.
 * License: MIT.
 * 
 * Ported to TypeScript by Wayne Nilsen / Claude-3.5-sonnet.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";


function dumbMigrateDb(db: Database, schema: string, allowDeletions: boolean = false): boolean {
    const migrator = new DBMigrator(db, schema, allowDeletions);
    migrator.migrate();
    return migrator.nChanges > 0;
}

class DBMigrator {
    private db: Database;
    private schema: string;
    private allowDeletions: boolean;
    private pristine: Database;
    nChanges: number;
    private origForeignKeys: number | null;

    constructor(db: Database, schema: string, allowDeletions: boolean = false) {
        this.db = db;
        this.schema = schema;
        this.allowDeletions = allowDeletions;

        this.pristine = new Database(":memory:");
        this.pristine.exec(schema);
        this.nChanges = 0;

        this.origForeignKeys = null;
    }

    private logExecute(msg: string, sql: string | undefined, args: unknown[] = []): void {
        // It's important to log any changes we're making to the database for
        // forensics later
        let msgTmpl = "Database migration: %s";
        const msgArgv: any[] = [msg];
        if (sql) {
            msgTmpl += " with SQL:\n%s";
            msgArgv.push(leftPad(dedent(sql)));
        } else {
            msgTmpl += " (no SQL provided)";
        }
        if (args.length > 0) {
            msgTmpl += " args = %r";
            msgArgv.push(args);
        }
        console.log(msgTmpl, ...msgArgv);

        if (sql && sql.trim()) {
            const result = this.db.run(sql, args as any[]); // Type assertion needed here
            console.log(`Affected rows: ${result.changes}, Last insert ID: ${result.lastInsertRowid}`);
            this.nChanges++;
        } else {
            console.warn("Skipped execution due to empty or undefined SQL");
        }
    }

    migrate(): void {
        // In CI the database schema may be changing all the time. This checks
        // the current db and if it doesn't match database.sql we will
        // modify it so it does match where possible.
        const pristineTablesData = this.pristine.query<TableInfo, []>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'").all();
        const pristineTables = new Map(pristineTablesData.map(item => [item.name, item.sql]));
        const pristineIndicesData = this.pristine.query<TableInfo, []>("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all();
        const pristineIndices = new Map(pristineIndicesData.map(item => [item.name, item.sql]));

        const tablesData = this.db.query<TableInfo, []>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'").all();
        const tables = new Map(tablesData.map(item => [item.name, item.sql]));

        const newTables = new Set(pristineTables.keys());
        for (const tableName of tables.keys()) {
            newTables.delete(tableName);
        }

        const removedTables = new Set(tables.keys());
        for (const tableName of pristineTables.keys()) {
            removedTables.delete(tableName);
        }

        // Remove temporary migration tables from the removedTables set
        for (const tableName of removedTables) {
            if (tableName.endsWith('_migration_new')) {
                removedTables.delete(tableName);
            }
        }

        if (removedTables.size > 0 && !this.allowDeletions) {
            throw new Error(`Database migration: Refusing to delete tables ${Array.from(removedTables)}`);
        }

        const modifiedTables = new Set(
            Array.from(pristineTables.entries())
                .filter(([name, sql]) => {
                    const existingTableSql = tables.get(name);
                    return existingTableSql !== undefined && normaliseSql(existingTableSql) !== normaliseSql(sql);
                })
                .map(([name]) => name)
        );

        // This PRAGMA is automatically disabled when the db is committed
        this.db.run("PRAGMA defer_foreign_keys = TRUE");

        console.log("newTables", newTables);
        console.log("removedTables", removedTables);
        console.log("modifiedTables", modifiedTables);

        // New and removed tables are easy:
        for (const tblName of Array.from(newTables)) {
            const tableSql = pristineTables.get(tblName);
            if (tableSql) {
                this.logExecute(`Create table ${tblName}`, tableSql);
            } else {
                console.warn(`No SQL found for new table ${tblName}`);
            }
        }
        for (const tblName of Array.from(removedTables)) {
            this.logExecute(`Drop table ${tblName}`, `DROP TABLE ${tblName}`);
        }

        for (const tblName of Array.from(modifiedTables)) {
            const createTableSql = pristineTables.get(tblName);
            if (!createTableSql) {
                console.warn(`No SQL found for modified table ${tblName}`);
                continue;
            }

            // The SQLite documentation insists that we create the new table and
            // rename it over the old rather than moving the old out of the way
            // and then creating the new
            const newTableSql = createTableSql.replace(new RegExp(`\\b${tblName}\\b`, "g"), `${tblName}_migration_new`);
            this.logExecute(
                `Columns change: Create table ${tblName} with updated schema`,
                newTableSql
            );

            const cols = new Set(this.db.prepare<PragmaResult, [string]>(`PRAGMA table_info(?)`).all(tblName).map(x => x.name));
            const pristineCols = new Set(this.pristine.prepare<PragmaResult, [string]>(`PRAGMA table_info(?)`).all(tblName).map(x => x.name));

            const removedColumns = new Set(Array.from(cols).filter(x => !pristineCols.has(x)));
            if (!this.allowDeletions && removedColumns.size > 0) {
                console.warn(
                    `Database migration: Refusing to remove columns ${Array.from(removedColumns)} from ` +
                    `table ${tblName}. Current cols are ${Array.from(cols)} attempting migration to ${Array.from(pristineCols)}`
                );
                throw new Error(
                    `Database migration: Refusing to remove columns ${Array.from(removedColumns)} from ` +
                    `table ${tblName}`
                );
            }

            console.log("cols:", cols, "pristine_cols:", pristineCols);
            this.logExecute(
                `Migrate data for table ${tblName}`,
                `INSERT INTO ${tblName}_migration_new (${Array.from(cols).filter(x => pristineCols.has(x)).join(", ")})
                SELECT ${Array.from(cols).filter(x => pristineCols.has(x)).join(", ")} FROM ${tblName}`
            );

            // Don't need the old table any more
            this.logExecute(
                `Drop old table ${tblName} now data has been migrated`,
                `DROP TABLE ${tblName}`
            );

            this.logExecute(
                `Columns change: Move new table ${tblName} over old`,
                `ALTER TABLE ${tblName}_migration_new RENAME TO ${tblName}`
            );
        }

        // Migrate the indices
        const indicesData = this.db.query<TableInfo, []>("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all();
        const indices = new Map(indicesData.map(item => [item.name, item.sql]));
        for (const name of indices.keys()) {
            if (!pristineIndices.has(name)) {
                this.logExecute(`Dropping obsolete index ${name}`, `DROP INDEX ${name}`);
            }
        }
        for (const [name, sql] of pristineIndices) {
            if (!indices.has(name)) {
                this.logExecute(`Creating new index ${name}`, sql);
            } else if (sql !== indices.get(name)) {
                this.logExecute(
                    `Index ${name} changed: Dropping old version`,
                    `DROP INDEX ${name}`
                );
                this.logExecute(
                    `Index ${name} changed: Creating updated version in its place`,
                    sql
                );
            }
        }

        this.migratePragma('user_version');

        if (this.pristine.query<PragmaResult, []>("PRAGMA foreign_keys").get()?.[0]) {
            if (this.db.query<PragmaResult, []>("PRAGMA foreign_key_check").all().length > 0) {
                throw new Error("Database migration: Would fail foreign_key_check");
            }
        }

        // Cleanup: remove any leftover temporary tables
        const leftoverTempTables = this.db.query<{ name: string }, any>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_migration_new'").all();
        for (const { name } of leftoverTempTables) {
            this.logExecute(`Removing leftover temporary table`, `DROP TABLE IF EXISTS ${name}`);
        }
    }

    private migratePragma(pragma: string): void {
        const pristineVal = this.pristine.query<PragmaResult, []>(`PRAGMA ${pragma}`).get();
        const val = this.db.query<PragmaResult, []>(`PRAGMA ${pragma}`).get();

        if (pristineVal && val) {
            const pristinePragmaValue = pristineVal[pragma];
            const currentPragmaValue = val[pragma];

            if (currentPragmaValue !== pristinePragmaValue) {
                this.logExecute(
                    `Set ${pragma} to ${pristinePragmaValue} from ${currentPragmaValue}`,
                    `PRAGMA ${pragma} = ${pristinePragmaValue}`
                );
            }
        }
    }
}

interface TableInfo {
    name: string;
    sql: string;
}

interface ColumnInfo {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
}

interface PragmaResult {
    [key: string]: number;
}

function leftPad(text: string, indent: string = "    "): string {
    return text.split('\n').map(line => indent + line).join('\n');
}

function dedent(text: string): string {
    const lines = text.split('\n');
    const minIndent = Math.min(...lines.filter(line => line.trim()).map(line => line.match(/^\s*/)?.[0].length ?? Infinity));
    return lines.map(line => line.slice(minIndent)).join('\n');
}

function normaliseSql(sql: string): string {
    if (!sql) return ''; // Handle undefined or empty string case
    // Remove comments:
    sql = sql.replace(/--[^\n]*\n/g, "");
    // Normalise whitespace:
    sql = sql.replace(/\s+/g, " ");
    sql = sql.replace(/ *([(),]) */g, "$1");
    // Remove unnecessary quotes
    sql = sql.replace(/"(\w+)"/g, "$1");
    return sql.trim();
}

function testNormaliseSql(): void {
    const input = `
        CREATE TABLE "Node"( -- This is my table
            -- There are many like it but this one is mine
            A b, C D, "E F G", h)
    `;
    const expected = 'CREATE TABLE Node(A b,C D,"E F G",h)';
    const result = normaliseSql(input);
    console.assert(result === expected, `Expected: ${expected}, Got: ${result}`);
}


function main() {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error("Usage: bun run migrator-cli.ts <database_path> <schema_file_path>");
        process.exit(1);
    }

    const [dbPath, schemaPath] = args;

    try {
        const db = new Database(dbPath);
        const schema = readFileSync(schemaPath, 'utf-8');

        console.log(`Migrating database: ${dbPath}`);
        console.log(`Using schema from: ${schemaPath}`);

        const changed = dumbMigrateDb(db, schema, false);

        if (changed) {
            console.log("Database migration completed successfully.");
        } else {
            console.log("Database is already up to date.");
        }

        db.close();
    } catch (error) {
        console.error("Error during migration:", error);
        process.exit(1);
    }
}

main();



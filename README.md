# SQLite Schema Migrator

This project provides a simple, declarative schema migration tool for SQLite databases using TypeScript and Bun.

It is not complete, contributions are welcome. Be careful using this in production, it may have bugs.

## Overview

The migrator script allows you to define your desired SQLite schema in a SQL file and automatically applies the necessary changes to bring your existing database in line with that schema. It handles creating new tables, modifying existing tables, and managing indices.

## Features

- Declarative schema definition
- Automatic migration of existing databases
- Supports table creation, modification, and deletion
- Handles index creation and deletion
- Preserves data during migrations where possible
- Foreign key constraint checking

## Missing features

 - Start and commit a transaction.
 - Handle triggers and views.

## Prerequisites

- [Bun](https://bun.sh/) runtime

## Usage

1. Install `bun add -D bun-sqlite-migrate`
2. Define your desired schema in a SQL file (e.g., `schema.sql`):

```sql
-- Users table
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    -- ... other columns ...
);

-- ... other tables and indices ...
```

3. Run the migrator script:

```bash
bunx bun-sqlite-migrate --database <database_path> --schema <schema_file_path> [--allow-deletions]
```

The `--allow-deletions` flag is optional. If provided, it allows the deletion of tables and columns during migration. Use this flag with caution, as it may result in data loss.

4. Update the schema by adding a column and a table. For example, let's add a `created_at` column to the `users` table and create a new `posts` table:

```sql
-- Users table with new column
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    -- ... other columns ...
);

-- New posts table
CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ... other tables and indices ...
```

5. Run the migrator script again to apply the changes:

```bash
bunx bun-sqlite-migrate --database <database_path> --schema <schema_file_path> [--allow-deletions]
```

6. The migrator will automatically detect the changes and update your database schema accordingly, preserving existing data.

7. Repeat steps 4-6 whenever you need to make changes to your database schema.

Remember to always backup your database before running migrations, especially in a production environment.

## How It Works

The migrator script performs the following steps:

1. Creates an in-memory SQLite database with the desired schema
2. Compares the in-memory database structure with the existing database
3. Generates and executes the necessary SQL statements to modify the existing database
4. Checks foreign key constraints after migration

## Limitations

- The script does not handle complex data migrations. If you need to transform data during a migration, you may need to handle that separately.
Create your own sql script and run it. Update the schema file to match the changes you made in the one off migration file.
- By default, it does not allow deletion of tables or columns. To enable this, you need to modify the `allowDeletions` parameter in the code.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.

## Acknowledgements

- Original concept by William Manley
- Inspired by the article ["Declarative Schema Migration for SQLite"](https://david.rothlis.net/declarative-schema-migration-for-sqlite) by David Röthlisberger
- Ported to TypeScript by Wayne Nilsen / Claude-3.5-sonnet
